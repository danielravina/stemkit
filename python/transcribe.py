import argparse
import json
import os
import sys
import time
import wave

import numpy as np

# whisper hallucinates text during silence/instrumental passages; both
# fields come back on every segment, so filter on them before writing
# anything to disk instead of trusting whisper's own text output blindly
NO_SPEECH_THRESHOLD = 0.6
AVG_LOGPROB_THRESHOLD = -1.0


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


def fmt_lrc_time(seconds):
    seconds = max(0.0, seconds)
    minutes = int(seconds // 60)
    secs = seconds - minutes * 60
    return f"{minutes:02d}:{secs:05.2f}"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--model", default="medium")
    parser.add_argument("--ckpt-dir", required=True)
    parser.add_argument("--device", default="auto")
    args = parser.parse_args()

    import torch
    import torchaudio
    import whisper

    if args.device == "auto":
        if torch.cuda.is_available():
            device = "cuda"
        elif torch.backends.mps.is_available():
            device = "mps"
        else:
            device = "cpu"
    else:
        device = args.device
    if device == "cuda" and not torch.cuda.is_available():
        fail("GPU engine not available (no supported NVIDIA/AMD GPU, or the GPU build of torch is not installed)")

    audio, sr = load_wav(args.input)
    mono = audio.mean(axis=0).astype(np.float32)
    if sr != 16000:
        t = torch.from_numpy(mono)
        t = torchaudio.functional.resample(t, sr, 16000)
        mono = t.numpy().astype(np.float32)

    # whisper's own audio loader shells out to ffmpeg on PATH, which the app
    # doesn't rely on elsewhere (ffmpeg is bundled and invoked by full path);
    # feeding a pre-resampled numpy array bypasses that shell-out entirely
    emit(type="progress", stage="lyrics", pct=0, message=f"loading lyrics engine on {device}")
    try:
        # whisper's mps kernels are incomplete for some ops; cpu is the safe
        # fallback there, same reasoning as demucs's mps->cpu fallback
        load_device = "cpu" if device == "mps" else device
        model = whisper.load_model(args.model, device=load_device, download_root=args.ckpt_dir)
    except Exception as e:
        fail(f"lyrics engine load failed: {e}")

    emit(type="progress", stage="lyrics", pct=20, message="transcribing")
    try:
        result = model.transcribe(
            mono,
            fp16=(device == "cuda"),
            condition_on_previous_text=False,
        )
    except Exception as e:
        fail(f"transcription failed: {e}")

    emit(type="progress", stage="lyrics", pct=90, message="writing lyrics")

    lines = []
    for seg in result.get("segments", []):
        text = seg.get("text", "").strip()
        if not text:
            continue
        if seg.get("no_speech_prob", 0.0) >= NO_SPEECH_THRESHOLD:
            continue
        if seg.get("avg_logprob", 0.0) <= AVG_LOGPROB_THRESHOLD:
            continue
        lines.append((float(seg["start"]), text))

    os.makedirs(args.out, exist_ok=True)
    if lines:
        lrc_path = os.path.join(args.out, "lyrics.lrc")
        with open(lrc_path, "w", encoding="utf-8") as f:
            for start, text in lines:
                f.write(f"[{fmt_lrc_time(start)}]{text}\n")
        emit(type="done", lines=len(lines), out=lrc_path)
    else:
        emit(type="done", lines=0, out=None)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        fail(str(e)[:400] or e.__class__.__name__)
