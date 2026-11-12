"""Clean up the player's recording, mix it over the backing stems, put it on the video."""

from __future__ import annotations

from pathlib import Path
from typing import Callable

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
    s = dict(COMMON)
    s.update(INSTRUMENT_DEFAULTS.get(instrument, INSTRUMENT_DEFAULTS["other"]))
    for k, v in (overrides or {}).items():
        if k not in s:
            raise ValueError(f"unknown setting '{k}' for {instrument}; known: {sorted(s)}")
        s[k] = v
    return s


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

    # 1. the player's track
    progress("cleaning up your recording")
    entry_c, stop_c = entry_v - a0, stop_v - a0
    raw = loudness(cam_wav, entry_c, stop_c - entry_c)["lufs"]
    pregain = s["chain_lufs"] - raw if np.isfinite(raw) else 0.0
    windows = noise_windows(cam_wav, entry_c - 0.3)
    graph, kick = instrument_chain(instrument, s, pregain, windows)
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
    l_inst = loudness(inst, entry_c, stop_c - entry_c)["lufs"]
    l_back = loudness(back_all, *region)["lufs"]
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
    makeup = s["final_lufs"] - loudness(pre, *region)["lufs"]
    lim = 10 ** (s["limiter_db"] / 20)
    final = work / "mix.wav"
    run(["ffmpeg", "-v", "error", "-y", "-i", str(pre), "-af",
         f"volume={makeup:.2f}dB,afade=t=out:st={max(0.0, cut - s['fade']):.4f}:d={s['fade']},"
         f"alimiter=limit={lim:.4f}:level=disabled:attack=5:release=80",
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
    return {
        "output": str(out),
        "duration": round(o["duration"], 3),
        "loudness_lufs": meas["lufs"],
        "true_peak_dbtp": meas["true_peak"],
        "noise_profile_windows": windows,
        "gains_db": {"pre_chain": round(pregain, 2), "instrument": round(g_inst, 2),
                     "backing": round(g_back, 2), "makeup": round(makeup, 2)},
        "settings": s,
        "backing_stems": others,
        "ducked": ducked,
    }
