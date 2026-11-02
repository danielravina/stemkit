import argparse
import json
import os
import struct
import sys
import time
import wave
import numpy as np


def emit(**kwargs):
    print(json.dumps(kwargs), flush=True)


def fail(message):
    emit(type="error", message=str(message))
    sys.exit(1)


def load_audio_file(path):
    """Robust audio loader: tries soundfile first, falls back to standard wave"""
    try:
        import soundfile as sf
        data, sr = sf.read(path, dtype="float64")
        return data, sr
    except Exception:
        pass

    try:
        with wave.open(path, "rb") as w:
            sr = w.getframerate()
            channels = w.getnchannels()
            width = w.getsampwidth()
            frames = w.readframes(w.getnframes())
            if width == 2:
                audio = np.frombuffer(frames, dtype="<i2").astype(np.float64) / 32768.0
            elif width == 4:
                audio = np.frombuffer(frames, dtype="<f4").astype(np.float64)
            else:
                raise ValueError(f"unsupported sample width {width}")
            if channels > 1:
                audio = audio.reshape(-1, channels)
            return audio, sr
    except Exception as e:
        raise RuntimeError(f"Could not load audio from '{path}': {e}")


def main():
    parser = argparse.ArgumentParser(description="State-of-the-art Beat, Downbeat and BPM Tracking")
    parser.add_argument("--input", required=True, help="Path to input audio (drums.wav or mix.wav)")
    parser.add_argument("--out", required=False, default=None, help="Path to save output JSON")
    parser.add_argument("--click-out", default=None, help="Optional path to write click.wav audio stem")
    parser.add_argument("--device", default="auto", help="auto, cuda, mps, or cpu")
    parser.add_argument("--checkpoint", default="final0", help="Model checkpoint name")
    args = parser.parse_args()

    if not os.path.exists(args.input):
        fail(f"Input file not found: {args.input}")

    import torch

    if args.device == "auto":
        if torch.cuda.is_available():
            device = "cuda"
        elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            device = "mps"
        else:
            device = "cpu"
    else:
        device = args.device

    emit(type="progress", stage="model", pct=10, message=f"Loading beat_this model on {device}")

    try:
        from beat_this.inference import Audio2Beats
        # dbn=False uses the pure Transformer predictions without legacy DBN postprocessing
        a2b = Audio2Beats(checkpoint_path=args.checkpoint, dbn=False, device=device)
    except Exception as e:
        fail(f"Failed to load beat_this: {e}")

    emit(type="progress", stage="load_audio", pct=30, message="Loading audio")

    try:
        signal, sr = load_audio_file(args.input)
    except Exception as e:
        fail(f"Audio load failed: {e}")

    emit(type="progress", stage="tracking", pct=50, message="Analyzing beats and downbeats")

    t0 = time.time()
    try:
        beats, downbeats = a2b(signal, sr)
    except Exception as e:
        fail(f"Inference failed: {e}")

    elapsed = time.time() - t0

    beats = np.asarray(beats, dtype=np.float64)
    downbeats = np.asarray(downbeats, dtype=np.float64)

    if len(beats) < 2:
        bpm = 120.0
        meter = 4
        first_beat_offset = float(beats[0]) if len(beats) > 0 else 0.0
    else:
        intervals = np.diff(beats)
        valid_intervals = intervals[(intervals >= 0.2) & (intervals <= 2.0)]
        if len(valid_intervals) > 0:
            median_interval = float(np.median(valid_intervals))
            bpm = round(60.0 / median_interval, 1)
        else:
            bpm = 120.0

        first_beat_offset = float(beats[0])

        # Estimate meter (beats per bar) from beats between downbeats
        if len(downbeats) >= 2:
            counts = []
            for i in range(len(downbeats) - 1):
                db_curr = downbeats[i]
                db_next = downbeats[i + 1]
                b_in_bar = np.sum((beats >= db_curr - 0.05) & (beats < db_next - 0.05))
                if 2 <= b_in_bar <= 12:
                    counts.append(b_in_bar)
            meter = int(np.median(counts)) if len(counts) > 0 else 4
        else:
            meter = 4

    # Build downbeats lookup set (tolerance ~80ms)
    downbeat_indices = []
    if len(downbeats) > 0 and len(beats) > 0:
        for db in downbeats:
            idx = int(np.argmin(np.abs(beats - db)))
            if abs(beats[idx] - db) < 0.08:
                downbeat_indices.append(idx)
        downbeat_indices = sorted(list(set(downbeat_indices)))

    downbeat_set = set(downbeat_indices)
    beat_grid = []
    for i, t in enumerate(beats):
        beat_grid.append({
            "index": i,
            "time": round(float(t), 3),
            "is_downbeat": (i in downbeat_set)
        })

    result = {
        "bpm": bpm,
        "meter": meter,
        "firstBeatOffset": round(first_beat_offset, 3),
        "totalBeats": len(beats),
        "totalBars": len(downbeats),
        "beats": [round(float(t), 3) for t in beats],
        "downbeats": [round(float(t), 3) for t in downbeats],
        "grid": beat_grid,
        "tookSec": round(elapsed, 2)
    }

    if args.out:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2)

    # Synthesize click stem if requested
    if args.click_out:
        emit(type="progress", stage="click_wav", pct=90, message="Synthesizing click stem")
        try:
            total_samples = len(signal)
            click_out = np.zeros((2, total_samples), dtype=np.float32)
            db_times = set(np.round(downbeats, 2))

            for t in beats:
                is_down = round(t, 2) in db_times
                idx = int(t * sr)
                if idx >= total_samples:
                    continue
                freq = 1600.0 if is_down else 900.0
                amp = 0.85 if is_down else 0.55
                dur_samples = min(int(sr * 0.035), total_samples - idx)
                t_chunk = np.arange(dur_samples) / sr
                decay = np.exp(-t_chunk / 0.006)
                click = (np.sin(2 * np.pi * freq * t_chunk) * decay * amp).astype(np.float32)
                click_out[0, idx:idx + dur_samples] += click
                click_out[1, idx:idx + dur_samples] += click

            np.clip(click_out, -1.0, 1.0, out=click_out)
            os.makedirs(os.path.dirname(os.path.abspath(args.click_out)), exist_ok=True)
            import soundfile as sf
            sf.write(args.click_out, click_out.T, sr, subtype="FLOAT")
            emit(type="stem", name="click")
        except Exception as e:
            emit(type="warning", message=f"Failed to generate click.wav: {e}")

    emit(
        type="done",
        bpm=bpm,
        meter=meter,
        firstBeatOffset=round(first_beat_offset, 3),
        totalBeats=len(beats),
        totalBars=len(downbeats),
        tookSec=round(elapsed, 2),
        out=args.out
    )


if __name__ == "__main__":
    main()
