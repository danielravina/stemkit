"""A synthetic song with real structure, and a play-along recording of it with a known offset.

Song (120 bpm, 2 s bars, 60 s):
    0-8    intro    no drums, quiet backing
    8-24   verse    kick/snare/hats, a fill every 4th bar
    24-28  break    drums rest
    28-44  chorus   busier drums, crashes, backing a bit louder
    44-60  outro    verse drums, backing ~10 dB louder (a clear section change)

Recording: the drummer plays song time 8-44 (verse to end of chorus), with a different kit
(other pitches and filtering), ±4 ms human timing, a noisy room, and a clipping mic, starting
3 s into the camera audio. So song time = camera time + 5.0.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import numpy as np

SONG_SR = 44100
CAM_SR = 48000
BEAT = 0.5
BAR = 4 * BEAT
LAG = 5.0                  # song = cam + LAG
PLAY = (8.0, 44.0)         # song time the drummer plays
CAM_LEAD, CAM_TAIL = 3.0, 4.0
OUTRO = 44.0               # backing jumps here: the cut should land just before it


def drum_events(t0: float, t1: float) -> list[tuple[float, str]]:
    ev: list[tuple[float, str]] = []
    for bar_start in np.arange(0, 60, BAR):
        if not (t0 <= bar_start < t1):
            continue
        n = int(round(bar_start / BAR))
        if 8 <= bar_start < 24 or bar_start >= 44:             # verse / outro
            fill = n % 4 == 3
            ev += [(bar_start, "kick"), (bar_start + 1.0, "kick")]
            if n % 2 == 0:
                ev.append((bar_start + 1.75, "kick"))
            ev += [(bar_start + 0.5, "snare")]
            if fill:
                ev += [(bar_start + 1.5 + k * 0.125, "tom") for k in range(4)]
            else:
                ev.append((bar_start + 1.5, "snare"))
            ev += [(bar_start + k * 0.25, "hat") for k in range(8 if not fill else 6)]
        elif 28 <= bar_start < 44:                              # chorus
            ev += [(bar_start + k * BEAT, "kick") for k in range(4)]
            ev += [(bar_start + 0.5, "snare"), (bar_start + 1.5, "snare")]
            ev += [(bar_start + k * 0.125, "hat") for k in range(16)]
            if n % 4 == 2:
                ev.append((bar_start, "crash"))
    return sorted(ev)


def _hit(kind: str, sr: int, rnd: np.random.Generator, alt: bool) -> np.ndarray:
    """One drum hit. alt=True is the drummer's own kit (different pitches / colour)."""
    def env(sec, tau):
        t = np.arange(int(sec * sr)) / sr
        return t, np.exp(-t / tau)
    if kind == "kick":
        t, e = env(0.25, 0.06)
        f = (55 if alt else 62) + 60 * np.exp(-t / 0.02)
        return 0.9 * e * np.sin(2 * np.pi * np.cumsum(f) / sr)
    if kind in ("snare", "tom"):
        t, e = env(0.18, 0.04)
        tone = np.sin(2 * np.pi * ((190 if alt else 210) if kind == "snare" else (120 if alt else 140)) * t)
        noise = rnd.standard_normal(len(t))
        if alt:
            noise = np.convolve(noise, np.ones(3) / 3, "same")
        return (0.5 * tone + (0.5 if kind == "snare" else 0.15) * noise) * e
    if kind == "hat":
        t, e = env(0.05, 0.012)
        n = rnd.standard_normal(len(t))
        n = n - np.convolve(n, np.ones(4 if alt else 2) / (4 if alt else 2), "same")
        return 0.25 * n * e
    t, e = env(1.2, 0.35)                                       # crash
    n = rnd.standard_normal(len(t))
    return 0.3 * (n - np.convolve(n, np.ones(2) / 2, "same")) * e


def render_drums(events, sr, length, *, alt=False, jitter=0.0, offset=0.0, seed=0) -> np.ndarray:
    rnd = np.random.default_rng(seed)
    out = np.zeros(int(length * sr), np.float64)
    for t, kind in events:
        start = int(round((t + offset + (rnd.uniform(-jitter, jitter) if jitter else 0)) * sr))
        h = _hit(kind, sr, rnd, alt)
        end = min(len(out), start + len(h))
        if 0 <= start < len(out):
            out[start:end] += h[: end - start]
    return out


def backing(sr: int = SONG_SR, length: float = 60.0) -> dict[str, np.ndarray]:
    t = np.arange(int(length * sr)) / sr

    def level(intro, verse, chorus, outro):
        return np.select([t < 8, t < 28, t < 44], [intro, verse, chorus], outro)

    roots = np.array([55.0, 43.65, 65.41, 49.0])               # A F C G, one per bar
    root = roots[(t // BAR).astype(int) % 4]
    bass = level(0.08, 0.12, 0.15, 0.45) * np.sin(2 * np.pi * np.cumsum(root) / sr)
    bass *= 0.6 + 0.4 * (np.mod(t, BEAT) < 0.35)               # note per beat
    chord = sum(np.sin(2 * np.pi * np.cumsum(root * m * 4) / sr) for m in (1, 1.26, 1.5)) / 3
    other = level(0.05, 0.07, 0.1, 0.35) * chord
    melody = np.array([440, 494, 523, 587, 523, 494, 440, 392])[(t // BEAT).astype(int) % 8]
    vocals = level(0.0, 0.07, 0.09, 0.3) * np.sin(2 * np.pi * np.cumsum(melody) / sr)
    return {"bass": bass, "other": other, "vocals": vocals}


def write_wav(path: Path, x: np.ndarray, sr: int) -> Path:
    x = np.asarray(x, np.float32)
    if x.ndim == 1:
        x = np.stack([x, x], 1)
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(sr), "-ac", "2",
                    "-i", "-", "-c:a", "pcm_f32le", str(path)], input=x.tobytes(), check=True)
    return path


def make_song_dir(root: Path) -> Path:
    """A StemKit song folder: mix.wav + stems/{vocals,drums,bass,other}.wav."""
    stems = backing()
    stems["drums"] = 0.5 * render_drums(drum_events(0, 60), SONG_SR, 60.0, seed=1)
    for name, x in stems.items():
        write_wav(root / "stems" / f"{name}.wav", x, SONG_SR)
    write_wav(root / "mix.wav", sum(stems.values()), SONG_SR)
    return root


def make_camera(seed: int = 7) -> np.ndarray:
    """The drummer's take as the camera hears it (48 kHz)."""
    length = CAM_LEAD + (PLAY[1] - PLAY[0]) + CAM_TAIL
    off = CAM_LEAD - PLAY[0]                                    # song time -> camera time
    x = render_drums(drum_events(*PLAY), CAM_SR, length, alt=True, jitter=0.004, offset=off,
                     seed=seed)
    rnd = np.random.default_rng(seed)
    # a room: ~0.4 s diffuse tail, so the level never drops to the floor between hits
    n = int(0.4 * CAM_SR)
    ir = rnd.standard_normal(n) * np.exp(-np.arange(n) / (0.12 * CAM_SR))
    ir *= 0.35 / np.sqrt((ir ** 2).sum())
    x = x + _fft_convolve(x, ir)
    x *= 1.4 / np.abs(x).max()
    x = np.clip(x, -1, 1)                                       # the loudest hits overload the mic
    x += 10 ** (-55 / 20) * rnd.standard_normal(len(x))         # room / preamp noise
    return x


def _fft_convolve(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    m = 1 << int(np.ceil(np.log2(len(a) + len(b))))
    return np.fft.irfft(np.fft.rfft(a, m) * np.fft.rfft(b, m), m)[: len(a)]


def make_video(path: Path, cam: np.ndarray, audio_start: float = 0.0) -> Path:
    """A small mp4 (mpeg4 picture + AAC camera audio), audio starting audio_start s in."""
    wav = path.with_suffix(".cam.wav")
    write_wav(wav, cam, CAM_SR)
    dur = len(cam) / CAM_SR + audio_start
    cmd = ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
           f"testsrc=size=160x120:rate=10:duration={dur:.3f}"]
    if audio_start:
        cmd += ["-itsoffset", f"{audio_start}"]
    cmd += ["-i", str(wav), "-map", "0:v", "-map", "1:a", "-c:v", "mpeg4", "-q:v", "10",
            "-c:a", "aac", "-b:a", "192k", "-ar", "48000", str(path)]
    subprocess.run(cmd, check=True)
    wav.unlink()
    return path
