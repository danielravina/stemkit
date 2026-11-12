"""numpy-only musical key detection (Krumhansl-Kessler profiles).

CLI: key.py --input A.wav [--input B.wav ...]
prints one json line: {"type":"key","tonic":0-11 (C=0),"mode":"major"|"minor"}
"""
import argparse
import struct

import numpy as np

from separate import emit, fail, load_wav

MAX_SECONDS = 240
FRAME = 8192
HOP = 4096
MIN_HZ = 55.0
MAX_HZ = 2000.0

MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def read_wav(path):
    """load_wav (stdlib wave) rejects float32 wavs (fmt tag 3), which is what
    separate.py writes for stems, so parse those here and delegate the rest"""
    try:
        with open(path, "rb") as f:
            head = f.read(12)
            fmt = data = None
            while head[:4] == b"RIFF" and (chunk := f.read(8)) and len(chunk) == 8:
                cid, size = struct.unpack("<4sI", chunk)
                if cid == b"fmt ":
                    fmt = struct.unpack("<HHIIHH", f.read(16))
                    f.seek(size - 16 + (size & 1), 1)
                elif cid == b"data":
                    data = f.read(size)
                    break
                else:
                    f.seek(size + (size & 1), 1)
    except OSError:
        return load_wav(path)
    if fmt is None or data is None or fmt[0] != 3 or fmt[5] != 32:
        return load_wav(path)
    channels = fmt[1]
    if channels == 0:
        fail("empty wav")
    usable = len(data) // (4 * channels) * 4 * channels
    audio = np.frombuffer(data[:usable], dtype="<f4").reshape(-1, channels).T
    return audio.astype(np.float32), fmt[2]


def chroma(mono, sr):
    mono = np.asarray(mono, dtype=np.float32)[: int(MAX_SECONDS * sr)]
    if mono.size < FRAME:
        mono = np.pad(mono, (0, FRAME - mono.size))
    window = np.hanning(FRAME).astype(np.float32)
    freqs = np.fft.rfftfreq(FRAME, 1.0 / sr)
    bins = np.nonzero((freqs >= MIN_HZ) & (freqs <= MAX_HZ))[0]
    # pitch class per bin, A = 9
    pcs = (np.round(12 * np.log2(freqs[bins] / 440.0)).astype(int) + 9) % 12
    vec = np.zeros(12)
    for start in range(0, mono.size - FRAME + 1, HOP):
        mag = np.abs(np.fft.rfft(mono[start : start + FRAME] * window))[bins]
        vec += np.bincount(pcs, weights=np.log1p(mag), minlength=12)
    return vec


def detect_key(mono, sr):
    vec = chroma(mono, sr)
    if float(vec.sum()) < 1e-6:
        fail("no tonal content")
    scores = []
    for mode, profile in (("major", MAJOR), ("minor", MINOR)):
        for tonic in range(12):
            r = np.corrcoef(vec, np.roll(profile, tonic))[0, 1]
            scores.append((0.0 if np.isnan(r) else float(r), tonic, mode))
    scores.sort(key=lambda s: s[0], reverse=True)
    return scores[0][1], scores[0][2]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", action="append", required=True)
    args = ap.parse_args()
    mixes = []
    sr = None
    for path in args.input:
        audio, file_sr = read_wav(path)
        if sr is None:
            sr = file_sr
        elif file_sr != sr:
            fail(f"sample rate mismatch: {file_sr} vs {sr}")
        mixes.append(audio.mean(axis=0))
    n = min(m.size for m in mixes)
    if n == 0:
        fail("empty wav")
    mono = np.sum([m[:n] for m in mixes], axis=0)
    tonic, mode = detect_key(mono, sr)
    emit(type="key", tonic=tonic, mode=mode)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        fail(e)
