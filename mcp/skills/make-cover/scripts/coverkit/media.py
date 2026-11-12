"""ffmpeg / ffprobe helpers and small signal utilities."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

import numpy as np


class MediaError(RuntimeError):
    pass


def require_ffmpeg() -> None:
    for tool in ("ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            raise MediaError(f"{tool} not found on PATH")


def run(cmd: list[str], *, capture: bool = True) -> subprocess.CompletedProcess:
    p = subprocess.run(cmd, capture_output=capture, text=False)
    if p.returncode != 0:
        tail = (p.stderr or b"").decode(errors="replace")[-1500:]
        raise MediaError(f"command failed ({cmd[0]}): {tail}")
    return p


def probe(path: str | Path) -> dict:
    out = run([
        "ffprobe", "-v", "error", "-print_format", "json",
        "-show_streams", "-show_format", str(path),
    ]).stdout
    info = json.loads(out)
    streams = info.get("streams", [])
    v = next((s for s in streams if s.get("codec_type") == "video"), None)
    a = next((s for s in streams if s.get("codec_type") == "audio"), None)
    return {
        "duration": float(info["format"].get("duration", 0.0)),
        "video_codec": v.get("codec_name") if v else None,
        "video_duration": float(v.get("duration", 0) or 0) if v else None,
        "has_audio": a is not None,
        "audio_start": float(a.get("start_time", 0) or 0) if a else 0.0,
        "audio_rate": int(a.get("sample_rate", 0) or 0) if a else 0,
    }


def load_mono(path: str | Path, sr: int, start: float | None = None,
              dur: float | None = None) -> np.ndarray:
    cmd = ["ffmpeg", "-v", "error"]
    if start is not None:
        cmd += ["-ss", f"{start:.6f}"]
    if dur is not None:
        cmd += ["-t", f"{dur:.6f}"]
    cmd += ["-i", str(path), "-vn", "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"]
    return np.frombuffer(run(cmd).stdout, np.float32).copy()


def extract_audio(video: str | Path, out_wav: str | Path, sr: int = 48000) -> Path:
    """Camera audio as float wav. Sample 0 == the audio stream's start_time."""
    run(["ffmpeg", "-v", "error", "-y", "-i", str(video), "-vn", "-ac", "2",
         "-ar", str(sr), "-c:a", "pcm_f32le", str(out_wav)])
    return Path(out_wav)


_I_RE = re.compile(r"^\s+I:\s+(-?[\d.]+|-inf) LUFS", re.M)
_TP_RE = re.compile(r"^\s+Peak:\s+(-?[\d.]+|-inf) dBFS", re.M)


def loudness(path: str | Path, start: float | None = None,
             dur: float | None = None) -> dict:
    """Integrated loudness (LUFS) and true peak (dBTP) via ffmpeg ebur128."""
    cmd = ["ffmpeg", "-hide_banner", "-nostats"]
    if start is not None:
        cmd += ["-ss", f"{max(0.0, start):.3f}"]
    if dur is not None:
        cmd += ["-t", f"{dur:.3f}"]
    cmd += ["-i", str(path), "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"]
    err = subprocess.run(cmd, capture_output=True).stderr.decode(errors="replace")
    summary = err[err.rfind("Summary:"):] if "Summary:" in err else err
    i = _I_RE.search(summary)
    tp = _TP_RE.search(summary)
    to_f = lambda m: (float("-inf") if m.group(1) == "-inf" else float(m.group(1))) if m else float("nan")
    return {"lufs": to_f(i), "true_peak": to_f(tp)}


def rms_db(x: np.ndarray, hop: int) -> np.ndarray:
    n = len(x) // hop
    if n == 0:
        return np.zeros(0)
    fr = x[: n * hop].reshape(n, hop)
    return 20 * np.log10(np.sqrt((fr.astype(np.float64) ** 2).mean(1)) + 1e-9)


def spectral_flux(x: np.ndarray, n_fft: int = 512, hop: int = 110,
                  chunk: int = 20000) -> np.ndarray:
    """Positive log-spectral flux, mean-removed, half-wave rectified, unit std.

    Frame k is centred at (k + 1) * hop + n_fft / 2 samples.
    """
    if len(x) < n_fft + hop:
        return np.zeros(0)
    win = np.hanning(n_fft).astype(np.float32)
    frames = np.lib.stride_tricks.sliding_window_view(x, n_fft)[::hop]
    out = []
    prev = None
    for s in range(0, len(frames), chunk):
        mag = np.log1p(1000 * np.abs(np.fft.rfft(frames[s:s + chunk] * win, axis=1)))
        if prev is not None:
            mag = np.vstack([prev, mag])
        d = np.maximum(np.diff(mag, axis=0), 0).sum(1)
        out.append(d)
        prev = mag[-1:]
    f = np.concatenate(out)
    f = f - np.convolve(f, np.ones(31) / 31, "same")
    f[f < 0] = 0
    return (f / (f.std() + 1e-9)).astype(np.float32)


def peak_times(flux: np.ndarray, frame_dt: float, offset: float,
               pct: float = 90, radius: int = 3) -> np.ndarray:
    if len(flux) == 0:
        return np.zeros(0)
    thr = np.percentile(flux, pct)
    idx = [i for i in range(radius, len(flux) - radius)
           if flux[i] > thr and flux[i] == flux[i - radius:i + radius + 1].max()]
    return offset + np.asarray(idx, dtype=np.float64) * frame_dt
