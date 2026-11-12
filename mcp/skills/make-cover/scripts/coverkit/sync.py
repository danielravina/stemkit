"""Line a camera recording up with the song, and find where to cut the ending.

Time bases
    cam time   : seconds into the extracted camera audio (sample 0 = audio start_time)
    video time : cam time + audio_start
    song time  : seconds into the YouTube song / stems
    song = cam + lag
"""

from __future__ import annotations

import numpy as np

from .media import load_mono, peak_times, rms_db, spectral_flux

SR = 11025
HOP = 110                     # flux frame ~10 ms
DT = HOP / SR
FLUX_OFFSET = (512 / 2) / SR + DT


def _sum_tracks(paths: list[str]) -> np.ndarray:
    tracks = [load_mono(p, SR) for p in paths]
    n = max(len(t) for t in tracks)
    out = np.zeros(n, np.float32)
    for t in tracks:
        out[: len(t)] += t
    return out


def _activity(r: np.ndarray, ref: float) -> np.ndarray:
    return np.clip((r - (ref - 30)) / 30, 0, 1)


def _moving(x: np.ndarray, n: int) -> np.ndarray:
    return np.convolve(x, np.ones(n) / n, "same")


def playing_region(cam: np.ndarray) -> tuple[float, float, float]:
    """(entry, stop, ref_db) in cam time. stop = where the playing starts to die away."""
    r = rms_db(cam, 1102)                       # 0.1 s frames
    ref = float(np.percentile(r, 90))
    on = _moving((r > ref - 12).astype(float), 10) > 0.5
    idx = np.flatnonzero(on)
    if len(idx) == 0:
        return 0.0, len(cam) / SR, ref
    entry = max(0.0, (idx[0] - 5) * 0.1)
    # refine the entry to the first strong level jump
    seg = r[max(0, idx[0] - 15): idx[0] + 15]
    if len(seg) > 1:
        entry = (max(0, idx[0] - 15) + int(np.argmax(np.diff(seg))) + 1) * 0.1
    loud = np.flatnonzero(_moving(r, 5) > ref - 6)
    stop = (loud[-1] + 1) * 0.1 if len(loud) else (idx[-1] + 1) * 0.1
    return entry, stop, ref


def estimate_beat(flux: np.ndarray) -> float:
    f = flux - flux.mean()
    ac = np.correlate(f[: min(len(f), 6000)], f[: min(len(f), 6000)], "full")[len(f[:6000]) - 1:]
    lo, hi = int(0.3 / DT), int(1.0 / DT)
    k = lo + int(np.argmax(ac[lo:hi]))
    return k * DT


def find_lag(cam: np.ndarray, inst: np.ndarray, full_mix: np.ndarray,
             entry: float, stop: float, ref: float) -> dict:
    fc = spectral_flux(cam)
    fs = spectral_flux(inst)
    song_len = len(inst) / SR

    n2 = 1 << int(np.ceil(np.log2(len(fc) + len(fs))))
    c = np.fft.irfft(np.fft.rfft(fs, n2) * np.conj(np.fft.rfft(fc, n2)), n2)
    lags = np.concatenate([np.arange(0, n2 // 2), np.arange(-n2 // 2, 0)]) * DT
    valid = (lags + entry >= -1.0) & (lags + stop <= song_len + 1.0)
    if not valid.any():
        raise ValueError("song is shorter than the playing in the video")
    zo = (c - np.median(c[valid])) / (c[valid].std() + 1e-9)
    zo[~valid] = -99

    def onset_z(L: float) -> float:
        i = int(np.argmin(np.abs(lags - L)))
        return float(zo[max(0, i - 4): i + 5].max())

    # structure: where the instrument plays / rests
    rc = rms_db(cam, 1102)
    rs = rms_db(inst, 1102)
    ca = _activity(rc, ref)
    sa = _activity(rs, float(np.percentile(rs, 90)))

    def structure(L: float) -> float:
        k = int(round(L / 0.1))
        i0, i1 = max(0, -k), min(len(ca), len(sa) - k)
        if i1 - i0 < 50:
            return 0.0
        a, b = ca[i0:i1], sa[i0 + k: i1 + k]
        if a.std() < 1e-6 or b.std() < 1e-6:
            return 0.0
        return float(np.corrcoef(a, b)[0, 1])

    # anchor: the moment the player comes in should be a section start in the song
    rm = rms_db(full_mix, HOP)
    w = int(1.0 / DT)
    cs = np.concatenate([[0], np.cumsum(rm)])
    i = np.arange(len(rm))
    after = (cs[np.minimum(i + w, len(rm))] - cs[i]) / np.maximum(1, np.minimum(i + w, len(rm)) - i)
    before = (cs[i] - cs[np.maximum(i - w, 0)]) / np.maximum(1, i - np.maximum(i - w, 0))
    nov = np.where(i > w, after - before, 0)
    nz = (nov - nov.mean()) / (nov.std() + 1e-9)

    def anchor(L: float) -> float:
        j = int((entry + L) / DT)
        if j < 0 or j >= len(nz):
            return 0.0
        return float(nz[max(0, j - 5): j + 6].max())

    cand: list[float] = []
    for j in np.argsort(zo)[::-1]:
        if zo[j] < 0:
            break
        if all(abs(lags[j] - l) > 0.08 for l in cand):
            cand.append(float(lags[j]))
        if len(cand) >= 40:
            break

    beat = estimate_beat(fs)
    bar = 4 * beat
    best0 = max(cand, key=lambda L: onset_z(L) + anchor(L))
    alts = [best0 + k * bar for k in (-2, -1, 1, 2)]
    pool = cand + [a for a in alts if all(abs(a - c_) > 0.08 for c_ in cand)]
    st = np.array([structure(L) for L in pool])
    stz = (st - st.mean()) / (st.std() + 1e-9)
    rows = []
    for L, s in zip(pool, stz):
        o, a = onset_z(L), anchor(L)
        rows.append({"lag": round(L, 3), "score": round(o + float(s) + a, 2),
                     "onset": round(o, 2), "structure": round(float(s), 2), "anchor": round(a, 2)})
    rows.sort(key=lambda r: -r["score"])
    best = rows[0]["lag"]
    fine = refine_lag(cam, inst, best)
    for r in rows:
        r["bars_from_best"] = round((r["lag"] - best) / bar, 2)
    return {
        "lag": fine,
        "coarse_lag": best,
        "confidence": round(rows[0]["score"] - rows[1]["score"], 2) if len(rows) > 1 else None,
        "beat": round(beat, 4),
        "bpm": round(60 / beat, 1),
        "candidates": rows[:6],
        "bar_alternatives": [r for r in rows if abs(abs(r["bars_from_best"]) - round(abs(r["bars_from_best"]))) < 0.1
                             and 0 < abs(r["bars_from_best"]) <= 2.1][:4],
    }


def refine_lag(cam: np.ndarray, inst: np.ndarray, lag: float, span: float = 0.08) -> float:
    """Millisecond lag: share of camera onsets landing within 12 ms of a stem onset."""
    hop = 22
    dt = hop / SR
    off = (512 / 2) / SR + dt
    tc = peak_times(spectral_flux(cam, hop=hop), dt, off, pct=90, radius=5)
    ts = peak_times(spectral_flux(inst, hop=hop), dt, off, pct=85, radius=5)
    if len(tc) < 20 or len(ts) < 20:
        return lag
    steps = np.arange(lag - span, lag + span + 1e-9, 0.002)
    scores = []
    for L in steps:
        t = tc + L
        j = np.clip(np.searchsorted(ts, t), 1, len(ts) - 1)
        d = np.minimum(np.abs(ts[j] - t), np.abs(ts[j - 1] - t))
        scores.append((d < 0.012).mean())
    sm = np.convolve(scores, np.ones(5) / 5, "same")
    return round(float(steps[int(np.argmax(sm))]), 3)


def find_cut(backing: np.ndarray, stop_cam: float, lag: float,
             search_before: float = 2.5, search_after: float = 2.0) -> dict:
    """Song-time section boundary closest to where the player stops."""
    stop_song = stop_cam + lag
    r = rms_db(backing, HOP)
    w = int(0.5 / DT)
    lo = max(w, int((stop_song - search_before) / DT))
    hi = min(len(r) - w, int((stop_song + search_after) / DT))
    if hi <= lo:
        return {"boundary_song": None, "rise_db": 0.0, "stop_song": round(stop_song, 3)}
    rise = np.array([r[i:i + w].mean() - r[i - w:i].mean() for i in range(lo, hi)])
    k = int(np.argmax(rise))
    return {"boundary_song": round((lo + k) * DT, 3), "rise_db": round(float(rise[k]), 1),
            "stop_song": round(stop_song, 3)}


def analyze(cam_wav: str, audio_start: float, video_duration: float,
            stems: dict[str, str], instrument: str, mix: str | None = None,
            lag: float | None = None) -> dict:
    cam = load_mono(cam_wav, SR)
    inst_path = stems.get(instrument)
    full = load_mono(mix, SR) if mix else _sum_tracks(list(stems.values()))
    inst = load_mono(inst_path, SR) if inst_path else full
    backing_paths = [p for k, p in stems.items() if k != instrument]
    backing = _sum_tracks(backing_paths) if backing_paths else full

    entry, stop, ref = playing_region(cam)
    if lag is None:
        sync = find_lag(cam, inst, full, entry, stop, ref)
    else:
        sync = {"lag": float(lag), "candidates": [], "note": "lag given by caller"}
    L = sync["lag"]

    cut = find_cut(backing, stop, L)
    end_video = video_duration
    if cut["boundary_song"] is not None and cut["rise_db"] >= 6:
        # the rise detector lands mid-swell; end the fade just before it
        cut_video = cut["boundary_song"] - 0.1 - L + audio_start
        reason = f"next song section starts at {cut['boundary_song']:.2f}s (song time)"
    else:
        cut_video = stop + 1.5 + audio_start
        reason = "no clear section change near the end; cut 1.5 s after the playing stops"
    cut_video = float(min(cut_video, end_video))

    return {
        "instrument": instrument,
        "audio_start": round(audio_start, 4),
        "lag_cam": round(L, 3),
        "song_offset_at_video_start": round(L - audio_start, 3),
        "entry_video": round(entry + audio_start, 2),
        "entry_song": round(entry + L, 2),
        "stop_video": round(stop + audio_start, 2),
        "cut_video": round(cut_video, 3),
        "cut_reason": reason,
        "boundary": cut,
        "sync": sync,
    }
