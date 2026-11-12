"""The song library. Same files and rules as src/main/library.ts, so the app and the
MCP server see the same songs."""

from __future__ import annotations

import json
import math
import os
import re
import shutil
import tempfile
import threading
from pathlib import Path
from typing import Any, Callable

from .paths import StemKitError, data_dir

DEFAULT_STEMS = ["vocals", "drums", "bass", "other"]
ALL_STEMS = ["vocals", "drums", "bass", "other", "piano", "guitar"]
MODEL_DEFAULT = "roformer_hybrid"
MODEL_EXTENDED = "htdemucs_6s"
PITCH_MIN, PITCH_MAX = -6, 6

_MAJOR = ["C", "D♭", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"]
_MINOR = ["Cm", "C♯m", "Dm", "E♭m", "Em", "Fm", "F♯m", "Gm", "G♯m", "Am", "B♭m", "Bm"]
KEY_NAMES = _MAJOR + _MINOR

DEFAULT_SETTINGS = {"shifts": 1, "htdemucsFt": False, "roformerVocals": False, "gpuSplit": False,
                    "hideVideo": False, "exportFormat": "wav", "exportFolder": ""}


# Serialises read-modify-write of library.json inside this process (tool calls and split
# jobs run on different threads). The app does not take this lock, so a write from an open
# StemKit window can still race with ours; the app has the same race between its own windows.
_LOCK = threading.RLock()


def key_name(tonic: int, mode: str) -> str:
    return (_MAJOR if mode == "major" else _MINOR)[tonic % 12]


def is_finite_number(x: Any) -> bool:
    """JS `typeof x === 'number' && Number.isFinite(x)` (bools are not numbers)."""
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def _js_truthy(x: Any) -> bool:
    """JS `!!x`: empty containers are truthy there, NaN is falsy."""
    if x is None or x is False or x == "":
        return False
    if isinstance(x, (int, float)) and not isinstance(x, bool):
        return x != 0 and x == x
    return True


# ------------------------------------------------------------------ paths

def library_file() -> Path:
    return data_dir() / "library.json"


def song_dir(video_id: str) -> Path:
    if not video_id or not re.fullmatch(r"[\w-]+", video_id):
        raise StemKitError("Unknown song")
    return data_dir() / "songs" / video_id


def stems_dir(video_id: str) -> Path:
    return song_dir(video_id) / "stems"


def mix_wav(video_id: str) -> Path:
    return song_dir(video_id) / "mix.wav"


# ------------------------------------------------------------------ json io

def _write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".stemkit-", suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


def load_songs() -> list[dict]:
    try:
        data = json.loads(library_file().read_text(encoding="utf-8"))
        return data["songs"] if isinstance(data.get("songs"), list) else []
    except Exception:
        return []


def save_songs(songs: list[dict]) -> None:
    _write_json(library_file(), {"songs": songs})


def get_song(video_id: str) -> dict:
    s = next((s for s in load_songs() if s.get("videoId") == video_id), None)
    if not s:
        raise StemKitError(f"Unknown song {video_id}")
    return s


def mutate_songs(fn: Callable[[list[dict]], Any]) -> Any:
    """Load, change in place, save, under the in-process lock. Returns fn's result."""
    with _LOCK:
        songs = load_songs()
        out = fn(songs)
        save_songs(songs)
        return out


def upsert_song(song: dict) -> None:
    def fn(songs: list[dict]) -> None:
        songs[:] = [s for s in songs if s.get("videoId") != song["videoId"]]
        songs.insert(0, song)
    mutate_songs(fn)


def remove_song(video_id: str) -> None:
    d = song_dir(video_id)
    mutate_songs(lambda songs: songs.__setitem__(
        slice(None), [s for s in songs if s.get("videoId") != video_id]))
    shutil.rmtree(d, ignore_errors=True)


def stems_for(song: dict | None) -> list[str]:
    return list(song.get("stems") or DEFAULT_STEMS) if song else list(DEFAULT_STEMS)


def stems_present(video_id: str, stems: list[str]) -> bool:
    d = stems_dir(video_id)
    return d.exists() and all((d / f"{s}.wav").exists() for s in stems)


def describe(song: dict) -> dict:
    vid = song["videoId"]
    stems = {s: str(stems_dir(vid) / f"{s}.wav") for s in stems_for(song)
             if (stems_dir(vid) / f"{s}.wav").exists()}
    key = song.get("key") or {}
    return {**song,
            "url": None if song.get("source") == "local" else f"https://www.youtube.com/watch?v={vid}",
            "mix": str(mix_wav(vid)) if mix_wav(vid).exists() else None,
            "stem_files": stems,
            "key_effective": key.get("override") or key.get("detected"),
            "pitch": load_pitch(vid), "pan": load_pan(vid)}


# ------------------------------------------------------------------ key / pan / pitch

def set_key_override(video_id: str, override: str | None) -> dict:
    if override is not None and override not in KEY_NAMES:
        raise StemKitError(f"Unknown key; use one of {KEY_NAMES}")

    def fn(songs: list[dict]) -> dict:
        song = next((s for s in songs if s.get("videoId") == video_id), None)
        if not song:
            raise StemKitError("Unknown song")
        key = {k: v for k, v in (song.get("key") or {"detected": None}).items() if k != "override"}
        if override is not None:
            key["override"] = override
        song["key"] = key
        return key
    return mutate_songs(fn)


def patch_key(video_id: str, detected: str | None) -> dict | None:
    def fn(songs: list[dict]) -> dict | None:
        song = next((s for s in songs if s.get("videoId") == video_id), None)
        if not song:
            return None
        old = song.get("key") or {}
        song["key"] = {"detected": detected, **({"override": old["override"]} if old.get("override") else {})}
        return song["key"]
    return mutate_songs(fn)


def clamp_pitch(n) -> int:
    """src/shared/pitch-range.ts clampPitch (JS Math.round: halves go up)."""
    if not is_finite_number(n):
        return 0
    return int(min(PITCH_MAX, max(PITCH_MIN, math.floor(n + 0.5))))


def load_pitch(video_id: str) -> int:
    try:
        return clamp_pitch(json.loads((song_dir(video_id) / "pitch.json").read_text())["semitones"])
    except Exception:
        return 0


def save_pitch(video_id: str, semitones) -> int:
    get_song(video_id)
    v = clamp_pitch(semitones)
    _write_json(song_dir(video_id) / "pitch.json", {"semitones": v})
    return v


def _normalize_pan(song: dict, value) -> dict:
    out = {}
    if not isinstance(value, dict):
        return out
    for sid in stems_for(song):
        p = value.get(sid)
        if sid in ALL_STEMS and is_finite_number(p):
            out[sid] = max(-1.0, min(1.0, float(p)))
    return out


def load_pan(video_id: str) -> dict:
    try:
        song = next(s for s in load_songs() if s.get("videoId") == video_id)
        return _normalize_pan(song, json.loads((song_dir(video_id) / "pan.json").read_text()))
    except Exception:
        return {}


def save_pan(video_id: str, pans: dict) -> dict:
    song = get_song(video_id)
    merged = {**load_pan(video_id), **(pans or {})}
    v = _normalize_pan(song, merged)
    _write_json(song_dir(video_id) / "pan.json", v)
    return v


# ------------------------------------------------------------------ settings

def settings_file() -> Path:
    return data_dir() / "settings.json"


def load_settings() -> dict:
    try:
        data = json.loads(settings_file().read_text())
        return {**DEFAULT_SETTINGS, **(data if isinstance(data, dict) else {})}
    except Exception:
        return dict(DEFAULT_SETTINGS)


def save_settings(patch: dict) -> dict:
    """src/main/settings.ts saveSettings."""
    with _LOCK:
        m = {**load_settings(), **(patch or {})}
        shifts = m.get("shifts")
        nxt = {"shifts": 2 if is_finite_number(shifts) and shifts == 2 else 1,
               "htdemucsFt": _js_truthy(m.get("htdemucsFt")),
               "roformerVocals": _js_truthy(m.get("roformerVocals")),
               "gpuSplit": _js_truthy(m.get("gpuSplit")),
               "hideVideo": _js_truthy(m.get("hideVideo")),
               "exportFormat": "aac" if m.get("exportFormat") == "aac" else "wav",
               "exportFolder": m["exportFolder"].strip() if isinstance(m.get("exportFolder"), str) else ""}
        _write_json(settings_file(), nxt)
        return nxt


# ------------------------------------------------------------------ names (src/shared/export-rules.ts)

NAME_LIMIT = 120


def _u16_len(s: str) -> int:
    """JS string .length (UTF-16 code units): emoji count as 2."""
    return len(s.encode("utf-16-le", "surrogatepass")) // 2


def _u16_slice(s: str, n: int) -> str:
    """JS s.slice(0, n), except a character is never cut in half."""
    out, used = [], 0
    for ch in s:
        w = 2 if ord(ch) > 0xFFFF else 1
        if used + w > n:
            break
        out.append(ch)
        used += w
    return "".join(out)


def sanitize_name(name: str) -> str:
    """src/main/library.ts sanitizeName."""
    clean = re.sub(r'[\\/:*?"<>|]', "-", name).strip()
    if clean in (".", ".."):
        return "stems"
    return _u16_slice(clean, NAME_LIMIT) if clean else "stems"


def _shift_suffix(semitones: int) -> str:
    return "" if semitones == 0 else f" ({'+' if semitones > 0 else '-'}{abs(semitones)})"


def _with_suffix(title: str, suffix: str) -> str:
    room = max(0, NAME_LIMIT - _u16_len(suffix))
    head = _u16_slice(title, room).rstrip() if _u16_len(title) > room else title
    return f"{head}{suffix}"


def mixed_base_name(title: str, selected: list[str], all_stems: list[str], semitones: int) -> str:
    chosen = [s for s in all_stems if s in selected]
    instrumental = ("vocals" in all_stems and len(chosen) == len(all_stems) - 1
                    and "vocals" not in chosen)
    part = "instrumental" if instrumental else "+".join(chosen)
    return _with_suffix(title, f" - {part}{_shift_suffix(semitones)}")


def separate_folder_name(title: str, semitones: int) -> str:
    return _with_suffix(title, _shift_suffix(semitones))


def original_mix_name(title: str, semitones: int) -> str:
    return _with_suffix(title, _shift_suffix(semitones))
