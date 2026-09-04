import argparse
import hashlib
import json
import os
import struct
import sys
import time
import urllib.request
import wave

import numpy as np
import torch

CKPT_NAME = "MelBandRoformer.ckpt"
CKPT_URL = "https://huggingface.co/KimberleyJSN/melbandroformer/resolve/main/MelBandRoformer.ckpt"
# pinned LFS sha256 of the checkpoint (HuggingFace repo metadata); downloads
# are rejected unless they match, mirroring the check in src/main/env.ts
CKPT_SHA256 = "87201f4d31afb5bc79993230fc49446918425574db48c01c405e44f365c7559e"

# KimberleyJensen mel-band roformer vocal model (SDR vocals 10.98 on Multisong).
# https://github.com/ZFTurbo/Music-Source-Separation-Training
PARAMS = dict(
    dim=384,
    depth=6,
    stereo=True,
    num_stems=1,
    time_transformer_depth=1,
    freq_transformer_depth=1,
    num_bands=60,
    dim_head=64,
    heads=8,
    attn_dropout=0,
    ff_dropout=0,
    flash_attn=True,
    dim_freqs_in=1025,
    sample_rate=44100,
    stft_n_fft=2048,
    stft_hop_length=441,
    stft_win_length=2048,
    stft_normalized=False,
    mask_estimator_depth=2,
    multi_stft_resolution_loss_weight=1.0,
    multi_stft_resolutions_window_sizes=(4096, 2048, 1024, 512, 256),
    multi_stft_hop_size=147,
    multi_stft_normalized=False,
)
CHUNK_SIZE = 352800  # 8s at 44100
NUM_OVERLAP = 2
# batching >1 triggers pathological MPS paths (same runtime as fp32), so 1 it is
BATCH_SIZE = 1
MIN_CKPT_BYTES = 500_000_000


def emit(**kwargs):
    print(json.dumps(kwargs), flush=True)


def fail(message):
    emit(type="error", message=str(message))
    sys.exit(1)


def load_wav(path):
    try:
        with wave.open(path, "rb") as w:
            sr = w.getframerate()
            channels = w.getnchannels()
            width = w.getsampwidth()
            frames = w.readframes(w.getnframes())
    except Exception as e:
        fail(f"cannot read wav {path}: {e}")
    if width == 2:
        audio = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    elif width == 4:
        audio = np.frombuffer(frames, dtype="<f4").astype(np.float32)
    else:
        fail(f"unsupported sample width {width}")
    if channels == 0:
        fail("empty wav")
    return audio.reshape(-1, channels).T, sr


def save_wav_f32(path, data, sr):
    """write a 32-bit float wav (fmt tag 3); values above 1.0 are preserved"""
    channels, _ = data.shape
    payload = data.T.astype("<f4").tobytes()
    block_align = channels * 4
    header = b"RIFF" + struct.pack("<I", 36 + len(payload)) + b"WAVE"
    header += b"fmt " + struct.pack(
        "<IHHIIHH", 16, 3, channels, sr, sr * block_align, block_align, 32
    )
    header += b"data" + struct.pack("<I", len(payload))
    with open(path, "wb") as f:
        f.write(header)
        f.write(payload)


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 22), b""):
            h.update(block)
    return h.hexdigest()


def download_checkpoint(dest):
    """download the checkpoint with resume support and progress emits"""
    if os.path.exists(dest):
        return
    part = dest + ".part"
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    start = 0
    headers = {"User-Agent": "stemkit"}
    if os.path.exists(part):
        start = os.path.getsize(part)
        headers["Range"] = f"bytes={start}-"
    req = urllib.request.Request(CKPT_URL, headers=headers)
    last_emit = 0.0
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            total = int(res.headers.get("Content-Length", 0)) + (
                start if res.status == 206 else 0
            )
            mode = "ab" if res.status == 206 and start > 0 else "wb"
            with open(part, mode) as f:
                while True:
                    chunk = res.read(1 << 20)
                    if not chunk:
                        break
                    f.write(chunk)
                    now = time.time()
                    if now - last_emit >= 1.0 and total > 0:
                        pct = int(f.tell() / total * 100)
                        emit(
                            type="progress",
                            stage="separate",
                            pct=0,
                            message=f"Downloading vocals engine ({total // (1024 * 1024)}MB): {pct}%",
                        )
                        last_emit = now
    except Exception as e:
        fail(f"vocals engine download failed: {e}")
    if os.path.getsize(part) < MIN_CKPT_BYTES:
        fail(f"vocals engine download incomplete ({os.path.getsize(part)} bytes)")
    if sha256_of(part) != CKPT_SHA256:
        try:
            os.remove(part)
        except OSError:
            pass
        fail("vocals engine failed integrity check (sha256 mismatch)")
    os.replace(part, dest)
    emit(type="progress", stage="separate", pct=0, message="Vocals engine downloaded")


def resolve_device():
    if torch.cuda.is_available():
        return "cuda", True
    if torch.backends.mps.is_available():
        return "mps", True
    return "cpu", False


def load_model(ckpt_path, device, use_half):
    from models.bs_roformer.mel_band_roformer import MelBandRoformer

    model = MelBandRoformer(**PARAMS)
    ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=False)
    if isinstance(ckpt, dict) and "state_dict" in ckpt:
        ckpt = ckpt["state_dict"]
    model.load_state_dict(ckpt, strict=True)
    model.to(device)
    if use_half:
        model.half()
        # band_split accumulates large stft magnitudes and overflows fp16
        model.band_split.to(torch.float32)
    model.eval()
    return model


def separate(model, mix, device, use_half, on_progress):
    """chunked inference with overlap; mix is a (2, n) tensor on device"""
    total = mix.shape[-1]
    step = CHUNK_SIZE // NUM_OVERLAP
    border = CHUNK_SIZE - step
    fade_size = CHUNK_SIZE // 10
    length_init = total
    if length_init > 2 * border and border > 0:
        mix = torch.nn.functional.pad(mix, (border, border), mode="reflect")

    window = torch.ones(CHUNK_SIZE, device=device)
    window[:fade_size] = torch.linspace(0, 1, fade_size, device=device)
    window[-fade_size:] = torch.linspace(1, 0, fade_size, device=device)

    result = torch.zeros(mix.shape, device=device)
    counter = torch.zeros(mix.shape, device=device)

    with torch.inference_mode():
        i = 0
        batch_data = []
        batch_locations = []
        while i < mix.shape[-1]:
            part = mix[:, i : i + CHUNK_SIZE]
            chunk_len = part.shape[-1]
            pad_mode = "reflect" if chunk_len > CHUNK_SIZE // 2 else "constant"
            part = torch.nn.functional.pad(part, (0, CHUNK_SIZE - chunk_len), mode=pad_mode, value=0)
            if use_half:
                part = part.to(torch.float16)
            batch_data.append(part)
            batch_locations.append((i, chunk_len))
            i += step
            if len(batch_data) >= BATCH_SIZE or i >= mix.shape[-1]:
                arr = torch.stack(batch_data, dim=0)
                x = model(arr)
                for j, (start, seg_len) in enumerate(batch_locations):
                    win = window[:seg_len].clone()
                    if start == 0:
                        win[:fade_size] = 1
                    elif i >= mix.shape[-1]:
                        win[-fade_size:] = 1
                    result[..., start : start + seg_len] += x[j, :, :seg_len].float() * win
                    counter[..., start : start + seg_len] += win
                batch_data.clear()
                batch_locations.clear()
                on_progress(i / mix.shape[-1])

    est = result / counter.clamp(min=1e-8)
    if length_init > 2 * border and border > 0:
        est = est[..., border:-border]
    return est


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--ckpt-dir", required=True)
    parser.add_argument("--device", default="auto")
    args = parser.parse_args()

    vendor = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor")
    sys.path.insert(0, vendor)

    # fail fast before the ~913MB checkpoint download on GPU-less machines
    if args.device == "cuda" and not torch.cuda.is_available():
        fail("GPU engine not available (no NVIDIA GPU, or the CUDA build of torch is not installed)")

    ckpt_path = os.path.join(args.ckpt_dir, CKPT_NAME)
    if not os.path.exists(ckpt_path):
        emit(type="progress", stage="separate", pct=0, message="Downloading vocals engine (913MB, one time)")
        download_checkpoint(ckpt_path)

    if args.device == "auto":
        device, use_half = resolve_device()
    else:
        device = args.device
        use_half = device in ("cuda", "mps")
    emit(type="progress", stage="separate", pct=0, message=f"loading vocals engine on {device}")

    started = time.time()
    try:
        model = load_model(ckpt_path, device, use_half)
    except Exception as e:
        fail(f"vocals engine load failed: {e}")

    audio, sr = load_wav(args.input)
    if audio.shape[0] == 1:
        audio = np.repeat(audio, 2, axis=0)
    mix = torch.from_numpy(audio).to(device)

    last_emit = 0.0

    def on_progress(frac):
        nonlocal last_emit
        now = time.time()
        if now - last_emit >= 0.5:
            emit(type="progress", stage="separate", pct=min(99, int(frac * 100)))
            last_emit = now

    emit(type="progress", stage="separate", pct=0, message="separating")
    try:
        est = separate(model, mix, device, use_half, on_progress)
    except Exception as e:
        if device == "mps":
            emit(type="progress", stage="separate", pct=0, message=f"gpu failed ({e}), falling back to cpu")
            device = "cpu"
            use_half = False
            try:
                model = load_model(ckpt_path, device, use_half)
            except Exception as e2:
                fail(f"vocals engine load failed on cpu: {e2}")
            mix = mix.to("cpu").float()
            est = separate(model, mix, device, use_half, on_progress)
        else:
            fail(f"separation failed: {e}")

    vocals = est.cpu().numpy()
    if np.isnan(vocals).any():
        fail("separation produced invalid audio")
    os.makedirs(args.out, exist_ok=True)
    save_wav_f32(os.path.join(args.out, "vocals.wav"), vocals, sr)
    emit(type="stem", name="vocals")
    emit(
        type="done",
        stems=["vocals"],
        out_dir=args.out,
        seconds=round(time.time() - started, 1),
    )


if __name__ == "__main__":
    main()
