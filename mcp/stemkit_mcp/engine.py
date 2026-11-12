"""Search, download, split, detect key. Mirrors src/main/pipeline.ts + keydetect.ts and
drives the same python scripts with the same arguments."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import wave
from pathlib import Path
from typing import Callable

from . import library as L
from .paths import (StemKitError, ffmpeg, js_runtime_args, models_dir, require_engine,
                    scripts_dir, venv_python, venv_ytdlp)

Progress = Callable[[str], None]
AUDIO_EXTENSIONS = {"mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "wma", "aiff", "aif",
                    "alac", "webm"}

_busy: set[str] = set()
_busy_lock = threading.Lock()
_procs: dict[str, subprocess.Popen] = {}
_cancelled: set[str] = set()


# ------------------------------------------------------------------ ids

def parse_video_id(s: str) -> str | None:
    t = s.strip()
    for pat in (r"(?:youtube\.com/watch\?.*v=)([\w-]{11})", r"(?:youtu\.be/)([\w-]{11})",
                r"(?:youtube\.com/shorts/)([\w-]{11})", r"(?:youtube\.com/embed/)([\w-]{11})"):
        m = re.search(pat, t)
        if m:
            return m.group(1)
    return t if re.fullmatch(r"[\w-]{11}", t) else None


def local_song_id(file_path: str) -> str:
    """FNV-1a over UTF-16 code units, exactly like src/shared/local.ts localSongId."""
    h = 0x811C9DC5
    units = file_path.encode("utf-16-le")
    for i in range(0, len(units), 2):
        h ^= units[i] | (units[i + 1] << 8)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return f"local-{h:08x}"


# ------------------------------------------------------------------ processes

def _run(cmd: list[str], job: str | None = None,
         on_line: Callable[[str], None] | None = None) -> str:
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                         encoding="utf-8", errors="replace")
    if job:
        _procs[job] = p
    out: list[str] = []
    err_tail: list[str] = []

    def pump_err() -> None:
        for line in p.stderr:  # type: ignore[union-attr]
            err_tail.append(line)
            del err_tail[:-30]
            if on_line:
                on_line(line)

    t = threading.Thread(target=pump_err, daemon=True)
    t.start()
    for line in p.stdout:  # type: ignore[union-attr]
        out.append(line)
        if on_line:
            on_line(line)
    code = p.wait()
    t.join(timeout=2)
    _procs.pop(job or "", None)
    if job and job in _cancelled:
        raise StemKitError("Cancelled")
    if code != 0:
        raise StemKitError(f"{Path(cmd[0]).name} failed: {''.join(err_tail)[-800:]}")
    return "".join(out)


def cancel(video_id: str | None = None) -> list[str]:
    """Stop running splits. The split job then fails with 'Cancelled' and puts back the
    song's previous split, if it had one."""
    with _busy_lock:
        hit = [k for k in _busy if video_id is None or k == video_id]
        _cancelled.update(hit)
    for k in hit:
        p = _procs.get(k)
        if p:
            p.kill()
    return hit


def is_busy(video_id: str) -> bool:
    with _busy_lock:
        return video_id in _busy


def _check_cancelled(video_id: str) -> None:
    if video_id in _cancelled:
        raise StemKitError("Cancelled")


# ------------------------------------------------------------------ search

def search_youtube(query: str) -> list[dict]:
    q = query.strip()
    if not q:
        return []
    require_engine()
    raw = _run([str(venv_ytdlp()), *js_runtime_args(), "--no-warnings", "-J", "--flat-playlist",
                "--no-playlist", f"ytsearch15:{q}"])
    entries = json.loads(raw).get("entries") or []
    return [{"videoId": e["id"], "title": e["title"],
             "channel": e.get("uploader") or e.get("channel"),
             "duration": round(e["duration"]) if isinstance(e.get("duration"), (int, float)) else None,
             "url": f"https://www.youtube.com/watch?v={e['id']}"}
            for e in entries if isinstance(e.get("id"), str) and isinstance(e.get("title"), str)]


# ------------------------------------------------------------------ engine plan

def resolve_engine(requested: str, stems: list[str] | None) -> dict:
    s = L.load_settings()
    wants_vocals = not stems or "vocals" in stems
    if requested == L.MODEL_EXTENDED:
        engine = L.MODEL_EXTENDED
    elif requested == L.MODEL_DEFAULT and s["roformerVocals"] and wants_vocals:
        engine = L.MODEL_DEFAULT
    else:
        engine = "htdemucs_ft" if s["htdemucsFt"] else "htdemucs"
    tag = (engine + ("-ft" if s["htdemucsFt"] and engine != L.MODEL_EXTENDED else "")
           + ("@s2" if s["shifts"] == 2 else ""))
    device = "auto" if sys.platform == "darwin" else ("cuda" if s["gpuSplit"] else "cpu")
    return {"engine": engine, "tag": tag, "settings": s, "wants_vocals": wants_vocals,
            "device": device}


def _script_runner(job: str, progress: Progress, span: tuple[int, int], produced: list[str],
                   errors: list[str]) -> Callable[[str], None]:
    last = [0.0]

    def on_line(line: str) -> None:
        try:
            msg = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            return
        if msg.get("type") == "progress":
            pct = float(msg.get("pct") or 0)
            mapped = span[0] + pct / 100 * (span[1] - span[0])
            if time.time() - last[0] > 3 or msg.get("message"):
                last[0] = time.time()
                progress(f"separating {round(mapped)}%" + (f" — {msg['message']}" if msg.get("message") else ""))
        elif msg.get("type") == "error":
            errors.append(str(msg.get("message")))
        elif msg.get("type") == "done" and isinstance(msg.get("stems"), list):
            produced.extend(str(x) for x in msg["stems"])
    return on_line


def _separate(video_id: str, plan: dict, stems: list[str] | None, progress: Progress) -> list[str]:
    py, scripts = str(venv_python()), scripts_dir()
    out, mix = str(L.stems_dir(video_id)), str(L.mix_wav(video_id))
    L.stems_dir(video_id).mkdir(parents=True, exist_ok=True)
    s = plan["settings"]
    produced: list[str] = []
    errors: list[str] = []
    only = ["--only", ",".join(stems)] if stems else []
    base = [py, str(scripts / "separate.py"), "--input", mix, "--out", out,
            "--device", plan["device"], "--shifts", str(s["shifts"])]

    try:
        if plan["engine"] == L.MODEL_DEFAULT:
            others = [x for x in (stems or ["drums", "bass", "other", "vocals"]) if x != "vocals"]
            span = 35 if others else 100
            if plan["wants_vocals"]:
                progress("separating vocals (mel-band roformer)")
                _run([py, str(scripts / "roformer.py"), "--input", mix, "--out", out,
                      "--ckpt-dir", str(models_dir()), "--device", plan["device"]], video_id,
                     _script_runner(video_id, progress, (0, span), produced, errors))
            if others:
                model = "htdemucs_ft" if s["htdemucsFt"] else "htdemucs"
                _run(base + ["--model", model, "--only", ",".join(others)], video_id,
                     _script_runner(video_id, progress, (span, 100), produced, errors))
        else:
            _run(base + ["--model", plan["engine"], *only], video_id,
                 _script_runner(video_id, progress, (0, 100), produced, errors))
    except StemKitError:
        # the scripts report the reason as a JSON error line on stdout, then exit 1
        if errors and video_id not in _cancelled:
            raise StemKitError(f"Separation failed: {errors[-1]}") from None
        raise

    if errors:
        raise StemKitError(f"Separation failed: {errors[-1]}")
    if not produced or not L.stems_present(video_id, produced):
        raise StemKitError("Separation finished but stem files are missing")
    return produced


def detect_key(video_id: str, stems: list[str]) -> str | None:
    files = [str(L.stems_dir(video_id) / f"{s}.wav") for s in stems if s != "drums"
             and (L.stems_dir(video_id) / f"{s}.wav").exists()]
    inputs = files or [str(L.mix_wav(video_id))]
    try:
        out = subprocess.run([str(venv_python()), str(scripts_dir() / "key.py"),
                              *sum((["--input", f] for f in inputs), [])],
                             capture_output=True, text=True, timeout=120).stdout
    except (subprocess.TimeoutExpired, OSError):
        return None
    for line in out.splitlines():
        try:
            m = json.loads(line)
        except ValueError:
            continue
        if m.get("type") == "key" and isinstance(m.get("tonic"), int) and m.get("mode") in ("major", "minor"):
            return L.key_name(m["tonic"], m["mode"])
    return None


def cache_thumbnail(video_id: str, url: str | None = None) -> None:
    """Same cache as src/main/thumbs.ts, so the library shows art even with 'hide video' on."""
    import urllib.request
    from .paths import data_dir
    if not re.fullmatch(r"[\w-]{11}", video_id):
        return
    dest = data_dir() / "thumbs" / f"{video_id}.jpg"
    if dest.exists():
        return
    src = url if isinstance(url, str) and url.startswith("https://") else \
        f"https://i.ytimg.com/vi/{video_id}/mqdefault.jpg"
    try:
        with urllib.request.urlopen(src, timeout=10) as r:
            buf = r.read()
        if buf:
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(buf)
    except Exception:
        pass


def _wav_duration(path: Path) -> int:
    try:
        with wave.open(str(path)) as w:
            return round(w.getnframes() / w.getframerate())
    except Exception:
        return 0


def _convert(src: Path, dest: Path) -> None:
    _run([ffmpeg(), "-v", "error", "-y", "-i", str(src), "-af", "aresample=44100:resampler=soxr",
          "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", str(dest)])


# ------------------------------------------------------------------ split

def _looks_like_path(source: str) -> bool:
    s = source.strip()
    return "://" not in s and ("/" in s or "\\" in s or s.startswith("~")
                               or Path(s).suffix.lower().lstrip(".") in AUDIO_EXTENSIONS)


def split(source: str, model: str = L.MODEL_DEFAULT, stems: list[str] | None = None,
          progress: Progress = lambda _: None) -> dict:
    """YouTube URL / id or a local audio file -> stems in the library.

    If the split fails or is cancelled, the song's previous split (if any) is left as it was.
    """
    require_engine()
    if model not in (L.MODEL_DEFAULT, L.MODEL_EXTENDED):
        raise StemKitError(f"unknown model {model!r}; use {L.MODEL_DEFAULT} or {L.MODEL_EXTENDED}")
    if stems:
        bad = [s for s in stems if s not in L.ALL_STEMS]
        if bad:
            raise StemKitError(f"unknown stems {bad}; choose from {L.ALL_STEMS}")
    path = Path(source.strip()).expanduser()
    local = path.is_file()
    if local:
        if path.suffix.lower().lstrip(".") not in AUDIO_EXTENSIONS:
            raise StemKitError(f"unsupported audio file type {path.suffix}")
        # the app hashes the absolute path the file dialog gives it, symlinks not followed
        vid = local_song_id(os.path.abspath(path))
    else:
        vid = parse_video_id(source)
        if not vid:
            if _looks_like_path(source):
                raise StemKitError(f"No such audio file: {path}")
            raise StemKitError("Could not parse a YouTube URL or video id out of that")

    with _busy_lock:
        if vid in _busy:
            raise StemKitError("This song is already being processed")
        _busy.add(vid)
        _cancelled.discard(vid)
    backup: Path | None = None
    fresh = True
    try:
        plan = resolve_engine(model, stems)
        existing = next((s for s in L.load_songs() if s.get("videoId") == vid), None)
        covered = (existing and existing.get("model") == plan["tag"] and existing.get("stems")
                   and (not stems or all(x in existing["stems"] for x in stems)))
        if covered and L.stems_present(vid, L.stems_for(existing)):
            progress("already split with this engine — reusing it")
            return L.describe(existing)
        # same rule as the app's reuseOrPrepare: start over only when the engine changed or
        # files are missing; otherwise add the new stems next to the old ones. Unlike the app,
        # keep the old folder aside until the new split has worked.
        if existing and (existing.get("model") != plan["tag"]
                         or not L.stems_present(vid, L.stems_for(existing))):
            if L.song_dir(vid).exists():
                backup = L.song_dir(vid).with_name(f".{vid}.previous")
                shutil.rmtree(backup, ignore_errors=True)
                L.song_dir(vid).rename(backup)
        elif existing:
            fresh = False
        L.song_dir(vid).mkdir(parents=True, exist_ok=True)
        added = existing.get("addedAt") if existing else int(time.time() * 1000)
        started = time.time()

        if local:
            title, duration = path.stem, 0
            progress("converting to WAV")
            _convert(path, L.mix_wav(vid))
            duration = _wav_duration(L.mix_wav(vid))
        else:
            url = f"https://www.youtube.com/watch?v={vid}"
            progress("reading video info")
            meta = json.loads(_run([str(venv_ytdlp()), *js_runtime_args(), "-J", "--no-playlist",
                                    "--skip-download", url], vid))
            title = meta.get("title") if isinstance(meta.get("title"), str) else "Unknown title"
            duration = round(meta["duration"]) if isinstance(meta.get("duration"), (int, float)) else 0
            cache_thumbnail(vid, meta.get("thumbnail"))
            progress(f"downloading '{title}'")
            _run([str(venv_ytdlp()), *js_runtime_args(), "-f", "bestaudio/best", "--no-playlist",
                  "-o", str(L.song_dir(vid) / "raw.%(ext)s"), url], vid)
            raw = next((p for p in L.song_dir(vid).iterdir() if p.name.startswith("raw.")), None)
            if not raw:
                raise StemKitError("Download produced no file")
            progress("converting to WAV")
            _convert(raw, L.mix_wav(vid))
            raw.unlink(missing_ok=True)

        _check_cancelled(vid)
        produced = _separate(vid, plan, stems, progress)
        _check_cancelled(vid)
        progress("detecting key")
        detected = detect_key(vid, produced)
        prev_override = ((existing or {}).get("key") or {}).get("override")
        song = {"videoId": vid, "title": title, "duration": duration, "addedAt": added,
                "model": plan["tag"], "stems": produced, "took": round(time.time() - started),
                "key": {"detected": detected, **({"override": prev_override} if prev_override else {})}}
        if local:
            song["source"] = "local"
        L.upsert_song(song)

        folder = plan["settings"].get("exportFolder")
        if folder:
            from .exporter import copy_to_export_folder
            try:
                copy_to_export_folder(vid, folder, plan["settings"]["exportFormat"])
            except Exception as e:  # the split itself succeeded
                progress(f"auto-export to {folder} failed: {e}")
        if backup:
            shutil.rmtree(backup, ignore_errors=True)
        return L.describe(song)
    except BaseException:
        if fresh:
            shutil.rmtree(L.song_dir(vid), ignore_errors=True)
        if backup and backup.exists():
            backup.rename(L.song_dir(vid))
        raise
    finally:
        with _busy_lock:
            _busy.discard(vid)
            _cancelled.discard(vid)
