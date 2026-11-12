"""Export: the app's Export dialog without the dialog. Mirrors src/renderer/src/lib/exporter.ts
(per-stem gain -> stereo pan -> optional pitch shift, 44.1 kHz float WAV, scaled down only
if it would clip) and src/main/library.ts exportStems (auto-export folder copy)."""

from __future__ import annotations

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


def _ff(args: list[str]) -> None:
    p = subprocess.run([ffmpeg(), "-v", "error", "-y", *args], capture_output=True)
    if p.returncode != 0:
        raise StemKitError(p.stderr.decode(errors="replace")[-600:])


def _has_rubberband() -> bool:
    p = subprocess.run([ffmpeg(), "-hide_banner", "-filters"], capture_output=True, text=True)
    return " rubberband " in p.stdout


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


def _finish(src_wav: Path, dest_no_ext: Path, fmt: str) -> str:
    if fmt == "aac":
        dest = dest_no_ext.with_name(dest_no_ext.name + ".m4a")
        _ff(["-i", str(src_wav), "-c:a", "aac", "-b:a", "256k", str(dest)])
    else:
        dest = dest_no_ext.with_name(dest_no_ext.name + ".wav")
        shutil.move(str(src_wav), dest)
    return str(dest)


def export(video_id: str, mode: str = "mixed", stems: list[str] | None = None,
           volumes: dict[str, float] | None = None, pans: dict[str, float] | None = None,
           semitones: int | None = None, fmt: str | None = None, dest: str | None = None) -> dict:
    """mode: 'mixed' (one file of the chosen stems), 'separate' (one file per stem in a
    folder) or 'original' (the full song). Pan and pitch default to what the player saved."""
    song = L.get_song(video_id)
    all_stems = L.stems_for(song)
    settings = L.load_settings()
    fmt = fmt or settings["exportFormat"]
    if fmt not in ("wav", "aac"):
        raise StemKitError("format must be wav or aac")
    semis = L.clamp_pitch(L.load_pitch(video_id) if semitones is None else semitones)
    pan_map = L.load_pan(video_id) if pans is None else {**L.load_pan(video_id), **pans}
    vols = volumes or {}
    root = Path(dest).expanduser() if dest else Path.home() / "Downloads"
    root.mkdir(parents=True, exist_ok=True)
    title = song.get("title") or video_id

    chosen = [s for s in all_stems if (stems is None or s in stems)]
    files = {s: L.stems_dir(video_id) / f"{s}.wav" for s in chosen}
    missing = [s for s, f in files.items() if not f.exists()]
    if missing:
        raise StemKitError(f"stem files missing on disk: {missing}")

    with tempfile.TemporaryDirectory(dir=root, prefix=".stemkit-") as tmp:
        t = Path(tmp)
        if mode == "original":
            mix = L.mix_wav(video_id)
            if not mix.exists():
                raise StemKitError("This song has no original mix to export")
            _render([(str(mix), 1.0, 0.0)], semis, t / "o.wav")
            out = _finish(t / "o.wav", root / L.sanitize_name(L.original_mix_name(title, semis)), fmt)
            return {"path": out, "count": 1, "semitones": semis, "format": fmt}
        if not chosen:
            raise StemKitError("Select at least one stem")
        if mode == "mixed":
            _render([(str(files[s]), float(vols.get(s, 1.0)), float(pan_map.get(s, 0.0))) for s in chosen],
                    semis, t / "m.wav")
            name = L.sanitize_name(L.mixed_base_name(title, chosen, all_stems, semis))
            out = _finish(t / "m.wav", root / name, fmt)
            return {"path": out, "count": 1, "stems": chosen, "semitones": semis, "format": fmt}
        if mode == "separate":
            folder = root / L.sanitize_name(L.separate_folder_name(title, semis))
            folder.mkdir(parents=True, exist_ok=True)
            paths = []
            for s in chosen:
                _render([(str(files[s]), float(vols.get(s, 1.0)), float(pan_map.get(s, 0.0)))],
                        semis, t / f"{s}.wav")
                paths.append(_finish(t / f"{s}.wav", folder / L.sanitize_name(s), fmt))
            return {"path": str(folder), "files": paths, "count": len(paths),
                    "semitones": semis, "format": fmt}
    raise StemKitError("mode must be mixed, separate or original")


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
