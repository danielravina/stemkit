"""
Chordify — offline chord recognition for StemKit.

Runs locally on mix.wav (or any wav). No network, no API keys.
Produces a time-aligned chord sequence cached as chords.json.

Approach:
  mono mix -> STFT (hann 4096, hop 2048 @44100) -> 12-dim chromagram
  -> sliding-window aggregation (1.0s window, 0.5s hop)
  -> cosine template matching against 96 chord templates (12 roots × 8 qualities)
  -> temporal smoothing + merge -> chords.json

Dependencies: only numpy (already in StemKit's venv). No librosa.
Accuracy is template-matching class (~70-80% on pop/rock), good enough for
guitar play-along. Beat tracking / HMM can be added later without changing
the file format.

Wire: main process calls:
  python -m chords --input mix.wav --out chords.json [--hop 0.5 --win 1.0]
JSON is printed via `emit(type="done")` and written to --out.
"""

import argparse
import json
import sys
import struct
import wave
import time
import os

import numpy as np

NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
ENHARMONIC_FLAT = {"C#": "Db", "D#": "Eb", "F#": "Gb", "G#": "Ab", "A#": "Bb"}

# quality -> intervals from root (semitones) + display suffix
QUALITIES = {
    "":    ([0, 4, 7], ""),        # major
    "m":   ([0, 3, 7], "m"),       # minor
    "7":   ([0, 4, 7, 10], "7"),   # dominant 7
    "maj7":([0, 4, 7, 11], "maj7"),
    "m7":  ([0, 3, 7, 10], "m7"),
    "dim": ([0, 3, 6], "dim"),
    "sus4":([0, 5, 7], "sus4"),
    "sus2":([0, 2, 7], "sus2"),
}

QUALITY_ORDER = ["", "m", "7", "m7", "maj7", "sus4", "sus2", "dim"]

# Bias against rare extensions: they must beat the base triad by a margin.
# Without this every noisy window picks maj7/m7 over plain major/minor because
# one extra pitch class (+0.08 cosine on uniform chroma) is spuriously rewarded.
QUALITY_BASE = {
    "7": "", "maj7": "", "m7": "m",
    "sus4": "", "sus2": "", "dim": "m"
}
QUALITY_MARGIN = {
    "7": 0.08, "maj7": 0.09, "m7": 0.08,
    "sus4": 0.06, "sus2": 0.06, "dim": 0.05
}

def emit(**kwargs):
    print(json.dumps(kwargs), flush=True)

def fail(message):
    emit(type="error", message=str(message))
    sys.exit(1)

def _read_wav_plain(path):
    """Read STEMKIT's mix.wav (float32 fmt=3). wave.py rejects_fmt=3 so do manual RIFF parse."""
    with open(path, 'rb') as f:
        hdr = f.read(44)
        if len(hdr) < 44 or hdr[0:4] != b'RIFF' or hdr[8:12] != b'WAVE':
            fail(f'not a wav: {path}')
        # walk RIFF chunks to find fmt + data (handles extra chunks like cue, LIST, etc.)
        pos = 12
        sr = None; ch = None; bits = None; fmt_tag = None
        data = None
        import struct as _st
        with open(path, 'rb') as rf:
            rf.seek(0)
            raw = rf.read()
        off = 12
        while off + 8 <= len(raw):
            cid = raw[off:off+4]
            size = _st.unpack_from('<I', raw, off+4)[0]
            if cid == b'fmt ':
                fmt_tag = _st.unpack_from('<H', raw, off+8)[0]
                ch = _st.unpack_from('<H', raw, off+10)[0]
                sr = _st.unpack_from('<I', raw, off+12)[0]
                bits = _st.unpack_from('<H', raw, off+22)[0]
            elif cid == b'data':
                data = raw[off+8: off+8+size]
                # we have what we need; keep scanning in case fmt came after (rare), but usually fmt first
                if sr is not None:
                    break
            off += 8 + size + (size % 2)
        if sr is None or ch is None or bits is None or fmt_tag is None or data is None:
            fail(f'cannot parse wav chunks in {path}')
        if fmt_tag == 1 and bits == 16:
            audio = np.frombuffer(data, dtype='<i2').astype(np.float32) / 32768.0
        elif fmt_tag == 1 and bits == 24:
            # 24-bit PCM: unpack manually (little-endian)
            n = len(data) // 3
            # pad to 4 bytes
            b32 = np.zeros(n, dtype=np.int32)
            # little-endian: data[0]=LSB
            # view as uint8 then shift
            u = np.frombuffer(data[:n*3], dtype=np.uint8).reshape(-1,3)
            b32 = (u[:,0].astype(np.int32) | (u[:,1].astype(np.int32) << 8) | (u[:,2].astype(np.int32) << 16))
            # sign-extend 24-bit
            b32 = np.where(b32 & 0x800000, b32 - 0x1000000, b32)
            audio = b32.astype(np.float32) / 8388608.0
        elif fmt_tag == 3 and bits == 32:
            audio = np.frombuffer(data, dtype='<f4').astype(np.float32)
        elif fmt_tag == 3 and bits == 64:
            audio = np.frombuffer(data, dtype='<f8').astype(np.float32)
        else:
            fail(f'unsupported wav fmt_tag={fmt_tag} bits={bits}')
        if ch == 0:
            fail('empty wav')
        if audio.size % ch != 0:
            fail('wav frame size mismatch')
        audio = audio.reshape(-1, ch) if ch>1 else audio.reshape(-1,1)
        return audio.T, sr

def load_wav(path):
    # Try stdlib wave first (int16 PCM), fall back to manual float32 decoder for STEMKIT mix.wav
    try:
        with wave.open(path, "rb") as w:
            sr = w.getframerate()
            ch = w.getnchannels()
            width = w.getsampwidth()
            frames = w.readframes(w.getnframes())
            if w.getcomptype() != 'NONE':
                raise ValueError(f"compressed wav {w.getcomptype()}")
            # wave.py will have already rejected float32 (fmt_tag=3) before we get here
            # So if we are here, width is valid and comptype is NONE => PCM
            if width == 1:
                audio = np.frombuffer(frames, dtype=np.uint8).astype(np.float32) / 128.0 - 1.0
            elif width == 2:
                audio = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
            elif width == 3:
                # rare: 24-bit PCM through wave (some wave.py versions do allow?)
                n = len(frames)//3
                u = np.frombuffer(frames[:n*3], dtype=np.uint8).reshape(-1,3)
                b32 = (u[:,0].astype(np.int32) | (u[:,1].astype(np.int32)<<8) | (u[:,2].astype(np.int32)<<16))
                b32 = np.where(b32 & 0x800000, b32 - 0x1000000, b32)
                audio = b32.astype(np.float32)/8388608.0
            elif width == 4:
                audio = np.frombuffer(frames, dtype="<i4").astype(np.float32)/2147483648.0
            else:
                fail(f"unsupported sample width {width}")
            if ch == 0:
                fail("empty wav")
            audio = audio.reshape(-1, ch).T
            if ch > 1:
                audio = audio.mean(axis=0)
            else:
                audio = audio[0]
            return audio.astype(np.float32), sr
    except Exception as e:
        # float32 wav produced by separate.py/roformer.py uses fmt_tag=3 which wave.py rejects
        # Fall through to manual parser
        if "unknown format" in str(e) or "fmt_tag" in str(e) or "Audio File" in str(e):
            pass
        else:
            # if we got here with a different error (file not found etc), surface it
            # but still try manual as fallback before failing
            try:
                mat, sr2 = _read_wav_plain(path)
                if mat.ndim==2:
                    mono = mat.mean(axis=0) if mat.shape[0]>1 else mat[0]
                else:
                    mono = mat
                return mono.astype(np.float32), sr2
            except Exception:
                fail(f"cannot read wav {path}: {e}")
    # fallback: manual RIFF parse for fmt=3 float32 wav (STEMKIT mix.wav)
    mat, sr = _read_wav_plain(path)
    if mat.ndim==2:
        mono = mat.mean(axis=0) if mat.shape[0]>1 else mat[0]
    else:
        mono = mat
    return mono.astype(np.float32), sr

def build_templates():
    """return dict (root, qual) -> 12-dim unit vector template"""
    templates = {}
    for root in range(12):
        for qual, (intervals, _suf) in QUALITIES.items():
            v = np.zeros(12, dtype=np.float32)
            for iv in intervals:
                pc = (root + iv) % 12
                # root gets highest weight; extensions much weaker so they need real evidence
                if iv == 0:
                    w = 1.0
                elif iv in (4, 3, 7):
                    w = 0.9
                else:
                    w = 0.50  # 7th extensions weaker (was 0.70). 0.42 killed true maj7, 0.50 preserves real maj7 while margin+gate kills noise
                v[pc] = w
            # normalize to unit length for cosine similarity
            n = np.linalg.norm(v)
            if n > 0:
                v /= n
            templates[(root, qual)] = v
    return templates

TEMPLATES = build_templates()

# Precomputed ordered list for argmax
TEMPLATE_LIST = []  # list of (root, qual, vec, label)
for root in range(12):
    for qual in QUALITY_ORDER:
        vec = TEMPLATES[(root, qual)]
        suf = QUALITIES[qual][1]
        label = NOTES[root] + suf
        TEMPLATE_LIST.append((root, qual, vec, label))

def stft_chroma(mono, sr, n_fft=4096, hop=2048, f_min=55):
    """STFT -> 12-D chroma, rows L2-normalized."""
    if len(mono) < n_fft:
        # pad short files
        pad = n_fft - len(mono)
        mono = np.concatenate([mono, np.zeros(pad, dtype=np.float32)])
    n_frames = 1 + (len(mono) - n_fft) // hop
    if n_frames <= 0:
        return np.zeros((0, 12), dtype=np.float32)

    window = np.hanning(n_fft).astype(np.float32)
    # precompute bin -> pitch class once
    freqs = np.fft.rfftfreq(n_fft, 1.0 / sr)  # size n_fft//2+1
    bin_pc = np.full(freqs.shape, -1, dtype=np.int32)
    # vectorized midi mapping
    # avoid log2(0)
    valid = freqs >= f_min
    # avoid divide by zero: use where
    midi = np.zeros_like(freqs, dtype=np.float32)
    midi[valid] = 69 + 12 * np.log2(freqs[valid] / 440.0)
    # round to nearest midi, wrap to pitch class
    pcs = np.round(midi).astype(int) % 12
    bin_pc[valid] = pcs[valid]
    # mask out ultra-high (above ~8000Hz contributes noise)
    bin_pc[freqs > 8000] = -1

    chroma_seq = np.zeros((n_frames, 12), dtype=np.float32)
    for i in range(n_frames):
        frame = mono[i*hop : i*hop+n_fft] * window
        # magnitude spectrum
        spec = np.fft.rfft(frame, n=n_fft)
        mag = np.abs(spec).astype(np.float32)
        # use power weighting to emphasize strong partials
        # compress with sqrt
        mag = np.sqrt(mag + 1e-9)
        # bincount per pitch class
        # only bins with valid pc
        valid_bins = bin_pc >= 0
        # np.bincount with weights
        c = np.bincount(bin_pc[valid_bins], weights=mag[valid_bins], minlength=12)
        c = c[:12].astype(np.float32)
        n = np.linalg.norm(c)
        if n > 1e-9:
            c /= n
        chroma_seq[i] = c
        # progress emit every 500 frames
        if i % 800 == 0 and n_frames > 2000:
            pct = int(i / n_frames * 30)
            emit(type="progress", stage="chords", pct=pct, message=f"analyzing {pct}%")

    return chroma_seq

def detect_chords(mono, sr, chord_win=1.0, chord_hop=0.5, threshold=0.45):
    """
    Returns list of dict segments.
    Fix for jazzy over-prediction: extensions (7/maj7 etc) need real
    evidence in the chroma — not just the best cosine by 0.08 on noise.
    We keep a penalized pick but also require the extension pitch-class
    to be present (>0.22 after per-window normalization) before allowing
    an upgrade from the triad. Without this Bangalore Days gave 109/121
    jazzy chords; after pen+evidence it drops to ~50/147 (F/Gm/Bb/C
    diatonic set, much closer to Chordify's plain triads).
    """
    n_fft = 4096
    hop = 2048
    stft_hop_time = hop / sr
    chroma_seq = stft_chroma(mono, sr, n_fft=n_fft, hop=hop)
    if chroma_seq.shape[0] == 0:
        return []

    # aggregate STFT chroma into chord windows
    win_frames = max(1, int(round(chord_win / stft_hop_time)))
    hop_frames = max(1, int(round(chord_hop / stft_hop_time)))

    times = []
    raw_labels = []
    raw_scores = []
    raw_roots = []
    raw_quals = []

    n_chords = 0
    # sliding
    idx = 0
    while True:
        start = idx * hop_frames
        end = start + win_frames
        if end > chroma_seq.shape[0]:
            # last partial window: if at least half window, include
            if start >= chroma_seq.shape[0]:
                break
            if (chroma_seq.shape[0] - start) < win_frames * 0.4:
                break
            end = chroma_seq.shape[0]
        window_chroma = chroma_seq[start:end].mean(axis=0)
        n = np.linalg.norm(window_chroma)
        if n > 1e-9:
            window_chroma /= n
        # cosine with penalized pick + extension evidence gate
        raw_by_key = {}
        pen_best = -1e9
        raw_best = -1.0
        pick_root = 0; pick_qual = ""; pick_label = "N"; pick_raw = 0.0
        for root, qual, vec, label in TEMPLATE_LIST:
            raw = float(np.dot(window_chroma, vec))
            raw_by_key[(root, qual)] = raw
            pen = raw - QUALITY_MARGIN.get(qual, 0.0)
            if pen > pen_best or (abs(pen - pen_best) < 1e-6 and raw > raw_best):
                pen_best = pen; raw_best = raw
                pick_root = root; pick_qual = qual; pick_label = label; pick_raw = raw
        # extension evidence gate: 7/maj7/m7 need their added tone present
        # triad tones are (0,3/4,7); extensions add E2 (7th) at 10 or 11.
        # sus adds 2 or 5. If that pc is weak (<0.22 of window_chroma) we
        # downgrade to the base triad of the same root.
        EXT_IV = {"7":10, "maj7":11, "m7":10, "dim":6, "sus4":5, "sus2":2}
        if pick_qual in EXT_IV:
            pc_ext = (pick_root + EXT_IV[pick_qual]) % 12
            # L2-normalized chroma: triad pcs 0.35-0.55, missing extensions <0.20.
            # Require evidence (0.24) — side-lobes leak at 0.22-0.25, so 0.24 is the sweet spot.
            if float(window_chroma[pc_ext]) < 0.24:
                base_qual = QUALITY_BASE.get(pick_qual, "")
                base_raw = raw_by_key.get((pick_root, base_qual), -1.0)
                if base_raw > -0.9 and pick_raw - base_raw < 0.12:
                    pick_qual = base_qual
                    pick_label = NOTES[pick_root] + QUALITIES[base_qual][1]
                    pick_raw = base_raw
        best_score = pick_raw
        best_root = pick_root; best_qual = pick_qual; best_label = pick_label
        # no-chord gate
        if best_score < threshold:
            best_label = "N"
            best_root = -1
            best_qual = "N"

        t = start * stft_hop_time
        times.append(t)
        raw_labels.append(best_label)
        raw_scores.append(best_score)
        raw_roots.append(best_root)
        raw_quals.append(best_qual)
        n_chords += 1
        idx += 1
        if end >= chroma_seq.shape[0]:
            break

    if not times:
        return []

    emit(type="progress", stage="chords", pct=45, message="smoothing")

    # temporal smoothing: median filter over 3 windows (voting)
    # simple: if label differs from both neighbors, snap to predecessor
    smoothed = raw_labels[:]
    s_roots = raw_roots[:]
    s_quals = raw_quals[:]
    for i in range(1, len(raw_labels)-1):
        if raw_labels[i] != raw_labels[i-1] and raw_labels[i] != raw_labels[i+1] and raw_labels[i-1] == raw_labels[i+1]:
            smoothed[i] = raw_labels[i-1]
            s_roots[i] = raw_roots[i-1]
            s_quals[i] = raw_quals[i-1]

    # hysteresis: suppress flips shorter than 1.0 sec (2 hops)
    # pass twice
    for _ in range(2):
        i = 0
        while i < len(smoothed):
            j = i
            while j < len(smoothed) and smoothed[j] == smoothed[i]:
                j += 1
            seg_len = j - i
            seg_time = seg_len * chord_hop
            if seg_time < 0.9 and i > 0 and j < len(smoothed):
                # flip to neighbor with higher score
                left_score = raw_scores[i-1] if i > 0 else 0
                right_score = raw_scores[j] if j < len(raw_scores) else 0
                # pick context: merge into whichever neighbor shares label otherwise predecessor
                target = smoothed[i-1] if smoothed[i-1] == smoothed[j] else (smoothed[i-1] if left_score >= right_score else smoothed[j])
                # find target root/qual
                target_root = s_roots[i-1] if left_score >= right_score else s_roots[j]
                target_qual = s_quals[i-1] if left_score >= right_score else s_quals[j]
                for k in range(i, j):
                    smoothed[k] = target
                    s_roots[k] = target_root
                    s_quals[k] = target_qual
                i = j
            else:
                i = j

    # collapse consecutive duplicates into segments
    segments = []
    i = 0
    total_dur = len(mono) / sr
    while i < len(smoothed):
        label = smoothed[i]
        root = s_roots[i]
        qual = s_quals[i]
        j = i + 1
        while j < len(smoothed) and smoothed[j] == label:
            j += 1
        t = times[i]
        # duration until next segment start or song end
        if j < len(times):
            dur = times[j] - t
        else:
            dur = total_dur - t
            # clamp
            if dur < chord_hop:
                dur = float(len(smoothed) - i) * chord_hop
        # avoid zero-length
        dur = max(0.35, float(dur))
        # skip leading/trailing N if very short, but keep interior silence as N
        # don't emit N for single-frame leading noise
        segments.append({
            "time": round(float(t), 3),
            "duration": round(float(dur), 3),
            "chord": label,
            "root": int(root),
            "quality": qual,
            "score": round(float(raw_scores[i]), 3),
        })
        i = j

    # second pass: merge N that is < 1s between same chord (re-articulation gap)
    merged = []
    for seg in segments:
        if merged and seg["chord"] == "N" and merged[-1]["chord"] != "N":
            # look ahead
            # peek next non-N
            # if next chord equals prev, absorb N
            # find next
            idx_seg = segments.index(seg)
            nxt = None
            for k in range(idx_seg+1, len(segments)):
                if segments[k]["chord"] != "N":
                    nxt = segments[k]
                    break
            if nxt and nxt["chord"] == merged[-1]["chord"] and seg["duration"] < 1.0:
                # extend previous instead of emitting N
                merged[-1]["duration"] = round(merged[-1]["duration"] + seg["duration"] + nxt["duration"] , 3)
                # skip nxt in next iter: mark
                # we achieve by skipping nxt when we encounter it
                # use flag: set seg to absorb and next iteration will see merged last equals nxt
                # easier: drop N and let loop merge nxt into merged[-1] by not pushing nxt separately
                # so we need to handle: consume nxt now
                # find nxt index and skip
                # instead we just skip emitting N and extend, and when nxt loops, it will be seen as same label as merged[-1] -> merge
                continue
        # normal merge with previous if same label
        if merged and merged[-1]["chord"] == seg["chord"]:
            merged[-1]["duration"] = round(merged[-1]["duration"] + seg["duration"], 3)
            # keep best score
            merged[-1]["score"] = max(merged[-1]["score"], seg["score"])
        else:
            merged.append(seg)

    # final filter: drop trailing N if at very end (<1s)
    if merged and merged[-1]["chord"] == "N" and merged[-1]["duration"] < 0.8:
        merged.pop()
    # drop leading N <0.6s
    if merged and merged[0]["chord"] == "N" and merged[0]["duration"] < 0.6:
        merged.pop(0)
        # rebase time to 0
        if merged:
            shift = merged[0]["time"]
            # keep absolute times, don't shift — player sync uses absolute

    return merged

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="path to wav (mix.wav)")
    parser.add_argument("--out", required=True, help="path to chords.json")
    parser.add_argument("--hop", type=float, default=0.5, help="chord hop in seconds")
    parser.add_argument("--win", type=float, default=1.0, help="chord window in seconds")
    parser.add_argument("--threshold", type=float, default=0.45, help="cosine threshold for N")
    args = parser.parse_args()

    if not os.path.exists(args.input):
        fail(f"input not found: {args.input}")

    emit(type="progress", stage="chords", pct=0, message="loading audio")
    mono, sr = load_wav(args.input)
    dur = len(mono) / sr
    emit(type="progress", stage="chords", pct=10, message=f"loaded {dur:.1f}s @ {sr}Hz")

    if dur < 1.0:
        fail("audio too short for chord detection")

    # simple resample if not 44100? STFT math assumes 44100 for hop calc but works at any sr;
    # we keep native sr and compute times from hop/sr so no resample needed.

    start = time.time()
    segments = detect_chords(mono, sr, chord_win=args.win, chord_hop=args.hop, threshold=args.threshold)
    elapsed = time.time() - start

    emit(type="progress", stage="chords", pct=90, message=f"found {len(segments)} segments")

    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
    out = {
        "version": 1,
        "duration": round(float(dur), 3),
        "hop": args.hop,
        "win": args.win,
        "generatedAt": int(time.time() * 1000),
        "chords": segments,
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)

    emit(type="progress", stage="chords", pct=100, message=f"done in {elapsed:.1f}s")
    emit(type="done", chords=segments, out=args.out, duration=dur, elapsed=round(elapsed, 2))

if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        fail(str(e)[:600] or e.__class__.__name__)
