"""Clean up the player's recording, mix it over the backing stems, put it on the video."""

from __future__ import annotations

from pathlib import Path
from typing import Callable

import functools
import os
import subprocess

import numpy as np

from .media import MediaError, load_mono, loudness, probe, rms_db, run

Progress = Callable[[str], None]

COMMON = {
    "inst_lufs": -16.5,      # player's track, measured over the playing
    "backing_lufs": -16.0,   # song minus the player's instrument
    "final_lufs": -13.0,     # whole mix before the limiter
    "limiter_db": -1.5,
    "fade": 0.2,             # fade-out at the cut, seconds
    "denoise_nr": 12,        # dB of noise reduction
    "aac_kbps": 320,
}

INSTRUMENT_DEFAULTS = {
    # tuned on a phone/action-cam drum recording that clips: tames fizz, adds kick body
    "drums": {"chain_lufs": -8.0, "kick_db": 6.0, "kick_freq": 60, "mud_db": -2.5,
              "fizz_db": -2.0, "fizz_freq": 3800, "air_db": -1.0,
              "kick_layer": 1.4, "kick_gate": 0.12, "duck": "light"},
    "bass": {"chain_lufs": -18.0, "comp_ratio": 3.0, "growl_db": 2.0},
    "vocals": {"chain_lufs": -18.0, "comp_ratio": 3.0, "presence_db": 2.0, "deess": True},
    "guitar": {"chain_lufs": -18.0, "comp_ratio": 2.0, "mud_db": -2.0},
    "piano": {"chain_lufs": -18.0, "comp_ratio": 2.0, "mud_db": -1.5},
    "other": {"chain_lufs": -18.0, "comp_ratio": 2.0, "mud_db": -2.0},
}

DUCK = {"off": None,
        "light": {"threshold": 0.5, "ratio": 2.0, "release": 100},
        "medium": {"threshold": 0.35, "ratio": 2.5, "release": 120}}


def settings(instrument: str, overrides: dict | None) -> dict:
    """Defaults for the instrument, with overrides checked against each default's type
    (values end up inside ffmpeg filter strings, so nothing but numbers / known words)."""
    s = dict(COMMON)
    s.update(INSTRUMENT_DEFAULTS.get(instrument, INSTRUMENT_DEFAULTS["other"]))
    for k, v in (overrides or {}).items():
        if k not in s:
            raise ValueError(f"unknown setting '{k}' for {instrument}; known: {sorted(s)}")
        d = s[k]
        if k == "duck":
            if v not in DUCK:
                raise ValueError(f"duck must be one of {sorted(DUCK)}, got {v!r}")
        elif isinstance(d, bool):
            if not isinstance(v, bool):
                raise ValueError(f"{k} must be true or false, got {v!r}")
        elif isinstance(d, (int, float)):
            if isinstance(v, bool) or not isinstance(v, (int, float)) or not np.isfinite(v):
                raise ValueError(f"{k} must be a number, got {v!r}")
        s[k] = v
    if s["fade"] < 0 or s["aac_kbps"] <= 0 or s["limiter_db"] > 0:
        raise ValueError("fade must be >= 0, aac_kbps > 0 and limiter_db <= 0")
    return s


SILENT_LUFS = -60.0   # ebur128 reports about -70 for digital silence


def _finite(name: str, x: float) -> float:
    if not np.isfinite(x) or x <= SILENT_LUFS:
        raise MediaError(f"could not measure the loudness of {name} (silent or unreadable); "
                         "check the entry / stop times or pass --lag / --cut")
    return float(x)


@functools.lru_cache(maxsize=None)
def _filter_has_option(name: str, option: str) -> bool:
    p = subprocess.run(["ffmpeg", "-hide_banner", "-h", f"filter={name}"], capture_output=True, text=True)
    return f" {option} " in p.stdout


@functools.lru_cache(maxsize=None)
def filter_latency(af: str, sr: int = 48000) -> float:
    """Seconds a filter chain delays its output (afftdn buffers ~25 ms in ffmpeg 6, other
    versions differ), measured on clicks over a noise floor."""
    rnd = np.random.default_rng(0)
    x = (0.001 * rnd.standard_normal(3 * sr)).astype(np.float32)
    for t in (1.0, 1.5, 2.0):
        x[int(t * sr): int(t * sr) + 200] += 0.5 * np.hanning(200).astype(np.float32)
    p = subprocess.run(["ffmpeg", "-v", "error", "-f", "f32le", "-ar", str(sr), "-ac", "1", "-i", "-",
                        "-af", af, "-f", "f32le", "-ac", "1", "-"], input=x.tobytes(), capture_output=True)
    if p.returncode != 0:
        raise MediaError(f"ffmpeg rejected '{af}': {p.stderr.decode(errors='replace')[-300:]}")
    y = np.frombuffer(p.stdout, np.float32)
    n = min(len(x), len(y))
    m = 1 << int(np.ceil(np.log2(2 * n)))
    c = np.fft.irfft(np.fft.rfft(y[:n], m) * np.conj(np.fft.rfft(x[:n], m)), m)
    w = int(0.1 * sr)
    k = int(np.argmax(np.concatenate([c[-w:], c[: w + 1]]))) - w
    return max(0, k) / sr


def _limiter(limit: float, attack_ms: float = 5, release_ms: float = 80) -> str:
    """alimiter delays its output by its look-ahead (= attack). Compensate, so the mix stays
    on the picture: latency=1 where ffmpeg has it (5.1+), else trim the attack off the front."""
    base = f"alimiter=limit={limit:.4f}:level=disabled:attack={attack_ms:g}:release={release_ms:g}"
    if _filter_has_option("alimiter", "latency"):
        return base + ":latency=1"
    return base + f",atrim=start={attack_ms / 1000:.4f},asetpts=PTS-STARTPTS"


def verify(video: str, out: Path, cut: float, s: dict, region: tuple[float, float],
           before: tuple[int, float]) -> dict:
    """Post-conditions of a render, measured on the written file."""
    src, o = probe(video), probe(out)
    want_dur = min(cut, src["duration"])
    meas = loudness(out)
    reg = loudness(out, *region)["lufs"]
    st = os.stat(video)
    checks = {
        "video_copied": {"ok": o["video_codec"] == src["video_codec"],
                         "value": o["video_codec"], "want": src["video_codec"]},
        "has_audio": {"ok": o["has_audio"] and o["audio_rate"] == 48000,
                      "value": o["audio_rate"], "want": 48000},
        "duration": {"ok": abs(o["duration"] - want_dur) <= 0.15,
                     "value": round(o["duration"], 3), "want": round(want_dur, 3)},
        "true_peak": {"ok": np.isfinite(meas["true_peak"]) and meas["true_peak"] <= s["limiter_db"] + 1.0,
                      "value": meas["true_peak"], "want": f"<= {s['limiter_db'] + 1.0}"},
        "loudness": {"ok": np.isfinite(reg) and abs(reg - s["final_lufs"]) <= 2.5,
                     "value": reg, "want": f"{s['final_lufs']} ± 2.5 over the playing"},
        "input_untouched": {"ok": (st.st_size, st.st_mtime) == before,
                            "value": True, "want": True},
    }
    return checks


def noise_windows(cam_wav: Path, entry_cam: float) -> list[tuple[float, float]]:
    """Up to two quiet 1 s stretches before the player starts, to learn the noise from."""
    if entry_cam < 1.6:
        return []
    x = load_mono(cam_wav, 11025, 0, entry_cam)
    r = rms_db(x, 1102)
    wins = []
    for i in range(3, len(r) - 10 - 3):
        m = float(r[i:i + 10].mean())
        if m > -90:
            wins.append((m, i * 0.1))
    if not wins:
        return []
    wins.sort()
    floor = wins[0][0]
    picked: list[tuple[float, float]] = []
    for m, t in wins:
        if m > floor + 6:
            break
        if all(abs(t - p[0]) >= 1.0 for p in picked):
            picked.append((round(t, 2), round(t + 1.0, 2)))
        if len(picked) == 2:
            break
    return sorted(picked)


def instrument_chain(instrument: str, s: dict, pregain: float,
                     windows: list[tuple[float, float]]) -> tuple[str, bool]:
    """ffmpeg filtergraph from [0:a] to [o]. Returns (graph, has_kick_layer)."""
    head = f"[0:a]aformat=sample_fmts=fltp,volume={pregain:.2f}dB,adeclip"
    if windows:
        cmds = "; ".join(f"{a:.2f} afftdn sn start; {b:.2f} afftdn sn stop" for a, b in windows)
        head += f",asendcmd=c='{cmds}'"
    head += f",afftdn=nr={s['denoise_nr']}:nf=-60"

    if instrument == "drums":
        body = (f",highpass=f=28,equalizer=f={s['kick_freq']}:t=q:w=1.1:g={s['kick_db']}"
                f",equalizer=f=350:t=q:w=1:g={s['mud_db']}"
                f",equalizer=f={s['fizz_freq']}:t=o:w=1:g={s['fizz_db']}"
                f",treble=g={s['air_db']}:f=9000")
        if s["kick_layer"] > 0:
            g = (head + body + ",asplit[m][l];"
                 f"[l]highpass=f=40,lowpass=f=110,lowpass=f=110,"
                 f"agate=threshold={s['kick_gate']}:range=0.06:ratio=4:attack=1:release=60[k];"
                 f"[m][k]amix=inputs=2:weights='1 {s['kick_layer']}':normalize=0[o]")
            return g, True
        return head + body + "[o]", False
    if instrument == "bass":
        body = (f",highpass=f=30,acompressor=threshold=-18dB:ratio={s['comp_ratio']}:attack=10:release=120"
                f",equalizer=f=800:t=q:w=1:g={s['growl_db']}")
    elif instrument == "vocals":
        body = ",highpass=f=80,equalizer=f=250:t=q:w=1:g=-2"
        if s["deess"]:
            body += ",deesser"
        body += (f",acompressor=threshold=-20dB:ratio={s['comp_ratio']}:attack=5:release=150"
                 f",equalizer=f=3000:t=q:w=1:g={s['presence_db']}")
    else:
        body = (f",highpass=f=70,equalizer=f=300:t=q:w=1:g={s['mud_db']}"
                f",acompressor=threshold=-20dB:ratio={s['comp_ratio']}:attack=10:release=150")
    return head + body + "[o]", False


def _align_song(song_offset: float) -> str:
    """Filters that place song time on the video timeline (song = video + song_offset)."""
    if song_offset >= 0:
        return f"atrim=start={song_offset:.4f},asetpts=PTS-STARTPTS"
    return f"adelay={-song_offset * 1000:.1f}:all=1"


def render(video: str, stems: dict[str, str], instrument: str, analysis: dict,
           out_path: str, work: Path, overrides: dict | None = None,
           progress: Progress = lambda _: None) -> dict:
    s = settings(instrument, overrides)
    info = probe(video)
    a0 = analysis["audio_start"]
    lag = analysis["lag_cam"]
    song_off = lag - a0
    cut = float(analysis["cut_video"])
    entry_v, stop_v = analysis["entry_video"], analysis["stop_video"]
    cam_wav = work / "camera.wav"
    out = Path(out_path).expanduser().resolve()
    if out == Path(video).expanduser().resolve():
        raise MediaError("output would overwrite the input video")
    if instrument not in stems:
        raise MediaError(
            f"this split has no '{instrument}' stem, so the original {instrument} part would stay "
            f"in the backing (stems: {sorted(stems)}). Re-split with htdemucs_6s for guitar or "
            "piano, or pass --instrument other to replace the whole 'other' stem.")
    st0 = os.stat(video)
    before = (st0.st_size, st0.st_mtime)

    # 1. the player's track
    progress("cleaning up your recording")
    entry_c, stop_c = entry_v - a0, stop_v - a0
    raw = _finite("your playing", loudness(cam_wav, entry_c, stop_c - entry_c)["lufs"])
    pregain = s["chain_lufs"] - raw
    windows = noise_windows(cam_wav, entry_c - 0.3)
    graph, kick = instrument_chain(instrument, s, pregain, windows)
    # the denoiser delays the playing; take that back off so it stays on the beat and picture
    lat = filter_latency(f"afftdn=nr={s['denoise_nr']}:nf=-60")
    if lat > 0:
        graph = graph[: -len("[o]")] + f",atrim=start={lat:.6f},asetpts=PTS-STARTPTS[o]"
    inst = work / "inst.wav"
    run(["ffmpeg", "-v", "error", "-y", "-i", str(cam_wav), "-filter_complex", graph,
         "-map", "[o]", "-c:a", "pcm_f32le", str(inst)])
    key = None
    duck = DUCK.get(s.get("duck", "off")) if instrument == "drums" else None
    if kick and duck and "bass" in stems:
        key = work / "kickkey.wav"
        run(["ffmpeg", "-v", "error", "-y", "-i", str(inst), "-af",
             f"highpass=f=40,lowpass=f=110,lowpass=f=110,agate=threshold={s['kick_gate']}"
             ":range=0.06:ratio=4:attack=1:release=60", "-c:a", "pcm_f32le", str(key)])

    # 2. the backing (song minus the player's instrument), on the video timeline
    progress("building the backing track")
    others = [k for k in stems if k != instrument]
    if not others:
        raise MediaError("no backing stems left after removing the instrument")
    ducked = ["bass"] if key is not None else []
    plain = [k for k in others if k not in ducked]
    align = _align_song(song_off)

    def sum_to(names: list[str], path: Path) -> Path:
        ins = sum((["-i", stems[n]] for n in names), [])
        mix = "".join(f"[{i}:a]" for i in range(len(names)))
        g = (f"{mix}amix=inputs={len(names)}:normalize=0,aresample=48000:resampler=soxr,"
             f"aformat=sample_fmts=fltp:channel_layouts=stereo,{align}[o]")
        run(["ffmpeg", "-v", "error", "-y", *ins, "-filter_complex", g, "-map", "[o]",
             "-c:a", "pcm_f32le", str(path)])
        return path

    back_all = sum_to(others, work / "backing.wav")
    back_plain = sum_to(plain, work / "backing_plain.wav") if ducked else back_all
    back_duck = sum_to(ducked, work / "backing_ducked.wav") if ducked else None

    # 3. levels
    region = (entry_v, max(1.0, min(stop_v, cut) - entry_v))
    l_inst = _finite("the cleaned-up playing", loudness(inst, entry_c, stop_c - entry_c)["lufs"])
    l_back = _finite("the backing", loudness(back_all, *region)["lufs"])
    g_inst = s["inst_lufs"] - l_inst
    g_back = s["backing_lufs"] - l_back

    # 4. mix
    progress("mixing")
    ins = ["-i", str(inst), "-i", str(back_plain)]
    g = (f"[0:a]aformat=sample_fmts=fltp:channel_layouts=stereo,volume={g_inst:.2f}dB,"
         f"adelay={a0 * 1000:.1f}:all=1[d];"
         f"[1:a]volume={g_back:.2f}dB[p];")
    parts = "[d][p]"
    n = 2
    if back_duck is not None:
        ins += ["-i", str(back_duck), "-i", str(key)]
        g += (f"[3:a]aformat=sample_fmts=fltp:channel_layouts=stereo,volume=6dB,"
              f"adelay={a0 * 1000:.1f}:all=1[key];"
              f"[2:a]volume={g_back:.2f}dB[b];"
              f"[b][key]sidechaincompress=threshold={duck['threshold']}:ratio={duck['ratio']}"
              f":attack=3:release={duck['release']}:knee=4[bd];")
        parts += "[bd]"
        n = 3
    g += f"{parts}amix=inputs={n}:normalize=0:duration=first,atrim=0:{cut:.4f}[o]"
    pre = work / "mix_pre.wav"
    run(["ffmpeg", "-v", "error", "-y", *ins, "-filter_complex", g, "-map", "[o]",
         "-c:a", "pcm_f32le", str(pre)])
    makeup = s["final_lufs"] - _finite("the mix", loudness(pre, *region)["lufs"])
    lim = 10 ** (s["limiter_db"] / 20)
    final = work / "mix.wav"
    run(["ffmpeg", "-v", "error", "-y", "-i", str(pre), "-af",
         f"volume={makeup:.2f}dB,afade=t=out:st={max(0.0, cut - s['fade']):.4f}:d={s['fade']},"
         + _limiter(lim),
         "-c:a", "pcm_f32le", str(final)])

    # 5. onto the video (picture copied, never re-encoded)
    progress("writing the video")
    tag = ["-tag:v", "hvc1"] if info["video_codec"] == "hevc" else []
    run(["ffmpeg", "-v", "error", "-y", "-i", video, "-i", str(final),
         "-map", "0:v:0", "-map", "1:a:0", "-t", f"{cut:.4f}", "-c:v", "copy", *tag,
         "-c:a", "aac", "-b:a", f"{s['aac_kbps']}k", "-ar", "48000",
         "-movflags", "+faststart", str(out)])
    run(["ffmpeg", "-v", "error", "-sseof", "-3", "-i", str(out), "-f", "null", "-"])
    o = probe(out)
    meas = loudness(out)
    checks = verify(video, out, cut, s, region, before)
    return {
        "output": str(out),
        "duration": round(o["duration"], 3),
        "loudness_lufs": meas["lufs"],
        "true_peak_dbtp": meas["true_peak"],
        "checks": checks,
        "checks_passed": all(c["ok"] for c in checks.values()),
        "noise_profile_windows": windows,
        "gains_db": {"pre_chain": round(pregain, 2), "instrument": round(g_inst, 2),
                     "backing": round(g_back, 2), "makeup": round(makeup, 2)},
        "settings": s,
        "backing_stems": others,
        "ducked": ducked,
    }
