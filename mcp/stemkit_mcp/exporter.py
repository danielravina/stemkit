"""Export: the app's Export dialog without the dialog. Mirrors src/renderer/src/lib/exporter.ts
(per-stem gain -> stereo pan -> optional pitch shift, 44.1 kHz float WAV, scaled down only
if it would clip) and src/main/library.ts exportStems (auto-export folder copy)."""

from __future__ import annotations

import functools
import math
import shutil
import subprocess
import tempfile
from pathlib import Path

import numpy as np

from . import library as L
from .paths import StemKitError, ffmpeg

SR = 44100
CEILING = 0.98855
MODES = ("mixed", "separate", "original")


def _ff(args: list[str]) -> None:
    p = subprocess.run([ffmpeg(), "-v", "error", "-y", *args], capture_output=True)
    if p.returncode != 0:
        raise StemKitError(p.stderr.decode(errors="replace")[-600:])


def _has_rubberband() -> bool:
    return _ffmpeg_has_filter(ffmpeg(), "rubberband")


@functools.lru_cache(maxsize=8)
def _ffmpeg_has_filter(exe: str, name: str) -> bool:
    p = subprocess.run([exe, "-hide_banner", "-filters"], capture_output=True, text=True)
    return f" {name} " in p.stdout


def _pan_filter(p: float) -> str:
    """Web Audio StereoPannerNode on a stereo input."""
    x = ((p + 1) if p <= 0 else p) * math.pi / 2
    gl, gr = math.cos(x), math.sin(x)
    if p <= 0:
        return f"pan=stereo|c0=c0+{gl:.6f}*c1|c1={gr:.6f}*c1"
    return f"pan=stereo|c0={gl:.6f}*c0|c1=c1+{gr:.6f}*c0"


def _pitch_filter(semitones: int) -> str:
    if semitones == 0:
        return ""
    ratio = 2 ** (semitones / 12)
    if _has_rubberband():
        return f",rubberband=pitch={ratio:.6f}:formant=preserved"
    # keeps duration, shifts formants too
    return f",asetrate={SR * ratio:.3f},aresample={SR},atempo={1 / ratio:.6f}"


def _render(sources: list[tuple[str, float, float]], semitones: int, dest_wav: Path) -> None:
    ins: list[str] = []
    chains = []
    for i, (path, gain, pan) in enumerate(sources):
        ins += ["-i", path]
        chains.append(f"[{i}:a]aresample={SR},aformat=sample_fmts=fltp:channel_layouts=stereo,"
                      f"volume={gain:.6f},{_pan_filter(pan)}[s{i}]")
    mix = "".join(f"[s{i}]" for i in range(len(sources)))
    g = ";".join(chains) + f";{mix}amix=inputs={len(sources)}:normalize=0:duration=longest"
    g += _pitch_filter(semitones) + "[o]"
    _ff([*ins, "-filter_complex", g, "-map", "[o]", "-ar", str(SR), "-c:a", "pcm_f32le", str(dest_wav)])
    _limit_peak(dest_wav)


def _limit_peak(wav: Path) -> None:
    """Scale down only when the render would clip (render-math.ts limitPeak)."""
    p = subprocess.run([ffmpeg(), "-v", "error", "-i", str(wav), "-f", "f32le", "-"], capture_output=True)
    x = np.frombuffer(p.stdout, np.float32)
    peak = float(np.abs(x).max()) if x.size else 0.0
    if peak > 1:
        tmp = wav.with_suffix(".tmp.wav")
        _ff(["-i", str(wav), "-af", f"volume={CEILING / peak:.6f}", "-c:a", "pcm_f32le", str(tmp)])
        tmp.replace(wav)


def _free(path: Path, overwrite: bool) -> Path:
    """path, or 'name (2).ext', 'name (3).ext'... when it exists and overwrite is off."""
    if overwrite or not path.exists():
        return path
    stem, ext = (path.name, "") if path.is_dir() else (path.stem, path.suffix)
    n = 2
    while True:
        cand = path.with_name(f"{stem} ({n}){ext}")
        if not cand.exists():
            return cand
        n += 1


def _finish(src_wav: Path, dest_no_ext: Path, fmt: str, overwrite: bool = False) -> str:
    ext = ".m4a" if fmt == "aac" else ".wav"
    dest = _free(dest_no_ext.with_name(dest_no_ext.name + ext), overwrite)
    if fmt == "aac":
        _ff(["-i", str(src_wav), "-c:a", "aac", "-b:a", "256k", str(dest)])
    else:
        shutil.move(str(src_wav), dest)
    return str(dest)


def _check_stem_map(name: str, value: dict | None, all_stems: list[str], lo: float,
                    hi: float | None) -> dict[str, float]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise StemKitError(f"{name} must be an object of stem -> number")
    out = {}
    for k, v in value.items():
        if k not in all_stems:
            raise StemKitError(f"{name}: this song has no '{k}' stem; it has {all_stems}")
        if not L.is_finite_number(v) or v < lo or (hi is not None and v > hi):
            rng = f"{lo}..{hi}" if hi is not None else f">= {lo}"
            raise StemKitError(f"{name}['{k}'] must be a number {rng}, got {v!r}")
        out[k] = float(v)
    return out


def export(video_id: str, mode: str = "mixed", stems: list[str] | None = None,
           volumes: dict[str, float] | None = None, pans: dict[str, float] | None = None,
           semitones: int | None = None, fmt: str | None = None, dest: str | None = None,
           overwrite: bool = False) -> dict:
    """mode: 'mixed' (one file of the chosen stems), 'separate' (one file per stem in a
    folder) or 'original' (the full song). Pan and pitch default to what the player saved.
    Existing files are kept: the new one gets ' (2)' etc. unless overwrite is set.
    Every argument is checked before anything is written."""
    if mode not in MODES:
        raise StemKitError(f"mode must be one of {list(MODES)}")
    song = L.get_song(video_id)
    all_stems = L.stems_for(song)
    settings = L.load_settings()
    fmt = fmt or settings["exportFormat"]
    if fmt not in ("wav", "aac"):
        raise StemKitError("format must be wav or aac")
    if stems is not None:
        unknown = [s for s in stems if s not in all_stems]
        if unknown:
            raise StemKitError(f"this song has no {unknown} stem(s); it has {all_stems}")
    if semitones is not None and not L.is_finite_number(semitones):
        raise StemKitError("semitones must be a number")
    vols = _check_stem_map("volumes", volumes, all_stems, 0.0, None)
    pans = _check_stem_map("pans", pans, all_stems, -1.0, 1.0)
    semis = L.clamp_pitch(L.load_pitch(video_id) if semitones is None else semitones)
    pan_map = {**L.load_pan(video_id), **pans}
    title = song.get("title") or video_id

    chosen = [s for s in all_stems if (stems is None or s in stems)]
    if mode != "original" and not chosen:
        raise StemKitError("Select at least one stem")
    files = {s: L.stems_dir(video_id) / f"{s}.wav" for s in chosen}
    missing = [s for s, f in files.items() if not f.exists()]
    if mode != "original" and missing:
        raise StemKitError(f"stem files missing on disk: {missing}")
    if mode == "original" and not L.mix_wav(video_id).exists():
        raise StemKitError("This song has no original mix to export")
    root = Path(dest).expanduser() if dest else Path.home() / "Downloads"
    root.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(dir=root, prefix=".stemkit-") as tmp:
        t = Path(tmp)
        if mode == "original":
            _render([(str(L.mix_wav(video_id)), 1.0, 0.0)], semis, t / "o.wav")
            out = _finish(t / "o.wav", root / L.sanitize_name(L.original_mix_name(title, semis)),
                          fmt, overwrite)
            return {"path": out, "count": 1, "semitones": semis, "format": fmt}
        if mode == "mixed":
            _render([(str(files[s]), vols.get(s, 1.0), pan_map.get(s, 0.0)) for s in chosen],
                    semis, t / "m.wav")
            name = L.sanitize_name(L.mixed_base_name(title, chosen, all_stems, semis))
            out = _finish(t / "m.wav", root / name, fmt, overwrite)
            return {"path": out, "count": 1, "stems": chosen, "semitones": semis, "format": fmt}
        folder = _free(root / L.sanitize_name(L.separate_folder_name(title, semis)), overwrite)
        folder.mkdir(parents=True, exist_ok=True)
        paths = []
        for s in chosen:
            _render([(str(files[s]), vols.get(s, 1.0), pan_map.get(s, 0.0))], semis, t / f"{s}.wav")
            paths.append(_finish(t / f"{s}.wav", folder / L.sanitize_name(s), fmt, overwrite=True))
        return {"path": str(folder), "files": paths, "count": len(paths),
                "semitones": semis, "format": fmt}


def copy_to_export_folder(video_id: str, folder: str, fmt: str) -> dict:
    """Settings > auto-export: raw stems + full track copied into <folder>/<title>/."""
    song = L.get_song(video_id)
    title = song.get("title") or video_id
    target = Path(folder).expanduser() / L.sanitize_name(title)
    target.mkdir(parents=True, exist_ok=True)
    ext = "m4a" if fmt == "aac" else "wav"
    n = 0
    sources = [(L.stems_dir(video_id) / f"{s}.wav", s) for s in L.stems_for(song)]
    sources.append((L.mix_wav(video_id), L.sanitize_name(title or "full track")))
    for src, name in sources:
        if not src.exists():
            continue
        dest = target / f"{name}.{ext}"
        if fmt == "aac":
            _ff(["-i", str(src), "-c:a", "aac", "-b:a", "256k", str(dest)])
        else:
            shutil.copyfile(src, dest)
        n += 1
    return {"path": str(target), "count": n}
