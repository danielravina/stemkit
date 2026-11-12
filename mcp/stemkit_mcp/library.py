"""The song library. Same files and rules as src/main/library.ts, so the app and the
MCP server see the same songs."""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
from pathlib import Path

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


def key_name(tonic: int, mode: str) -> str:
    return (_MAJOR if mode == "major" else _MINOR)[tonic % 12]


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


def upsert_song(song: dict) -> None:
    songs = [s for s in load_songs() if s.get("videoId") != song["videoId"]]
    songs.insert(0, song)
    save_songs(songs)


def remove_song(video_id: str) -> None:
    save_songs([s for s in load_songs() if s.get("videoId") != video_id])
    shutil.rmtree(song_dir(video_id), ignore_errors=True)


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
    songs = load_songs()
    song = next((s for s in songs if s.get("videoId") == video_id), None)
    if not song:
        raise StemKitError("Unknown song")
    key = {k: v for k, v in (song.get("key") or {"detected": None}).items() if k != "override"}
    if override is not None:
        key["override"] = override
    song["key"] = key
    save_songs(songs)
    return key


def patch_key(video_id: str, detected: str | None) -> dict | None:
    songs = load_songs()
    song = next((s for s in songs if s.get("videoId") == video_id), None)
    if not song:
        return None
    old = song.get("key") or {}
    song["key"] = {"detected": detected, **({"override": old["override"]} if old.get("override") else {})}
    save_songs(songs)
    return song["key"]


def clamp_pitch(n) -> int:
    if not isinstance(n, (int, float)) or n != n:
        return 0
    return int(min(PITCH_MAX, max(PITCH_MIN, round(n)))) + 0


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
        if sid in ALL_STEMS and isinstance(p, (int, float)) and p == p:
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
    m = {**load_settings(), **(patch or {})}
    nxt = {"shifts": 2 if m.get("shifts") == 2 else 1,
           "htdemucsFt": bool(m.get("htdemucsFt")),
           "roformerVocals": bool(m.get("roformerVocals")),
           "gpuSplit": bool(m.get("gpuSplit")),
           "hideVideo": bool(m.get("hideVideo")),
           "exportFormat": "aac" if m.get("exportFormat") == "aac" else "wav",
           "exportFolder": m["exportFolder"].strip() if isinstance(m.get("exportFolder"), str) else ""}
    _write_json(settings_file(), nxt)
    return nxt


# ------------------------------------------------------------------ names (src/shared/export-rules.ts)

NAME_LIMIT = 120


def sanitize_name(name: str) -> str:
    clean = re.sub(r'[\\/:*?"<>|]', "-", name).strip()
    if clean in (".", ".."):
        return "stems"
    return clean[:120] if clean else "stems"


def _shift_suffix(semitones: int) -> str:
    return "" if semitones == 0 else f" ({'+' if semitones > 0 else '-'}{abs(semitones)})"


def _with_suffix(title: str, suffix: str) -> str:
    room = max(0, NAME_LIMIT - len(suffix))
    head = title[:room].rstrip() if len(title) > room else title
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
