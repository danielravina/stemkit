"""StemKit as an MCP server: everything the app does, minus the window.

Works on the app's own data folder (library, stems, pan/pitch, settings) with the app's
own engine (venv + python/ scripts), so the app and the MCP client see the same songs.
"""

from __future__ import annotations

import time
from typing import Any

from mcp.server.mcpserver import MCPServer

from . import engine as E
from . import exporter as X
from . import jobs
from . import library as L
from .paths import data_dir, ffmpeg, scripts_dir, venv_python, venv_ytdlp

INSTRUCTIONS = """\
StemKit splits songs (from YouTube or local audio files) into stems: vocals, drums, bass,
other (+ guitar and piano with the 6-stem model). The library is shared with the StemKit app.

Flow: search_youtube -> split_song (a job; poll job_status) -> get_song for stem file paths,
key, pitch and pan -> export_audio for files people can use (one mixed file of chosen stems,
one file per stem, or the original), optionally pitch-shifted, panned and re-balanced.
Splitting takes a few minutes on CPU; long calls run as jobs (wait_seconds blocks up to 55 s)."""

mcp = MCPServer("stemkit", instructions=INSTRUCTIONS)


def _wait(jid: str, wait_seconds: float) -> dict:
    end = time.time() + max(0.0, min(wait_seconds, 55.0))
    while time.time() < end:
        st = jobs.status(jid)
        if st.get("status") != "running":
            return st
        time.sleep(1.0)
    return jobs.status(jid)


@mcp.tool()
def status() -> dict:
    """Is StemKit's engine installed, where is the data, which ffmpeg / scripts are used."""
    out: dict[str, Any] = {"data_dir": str(data_dir()), "python": str(venv_python()),
                           "engine_ready": venv_python().exists(), "yt_dlp": venv_ytdlp().exists()}
    for k, f in (("scripts", scripts_dir), ("ffmpeg", ffmpeg)):
        try:
            out[k] = str(f())
        except Exception as e:
            out[k] = f"missing: {e}"
    out["settings"] = L.load_settings()
    out["songs"] = len(L.load_songs())
    return out


@mcp.tool()
def search_youtube(query: str) -> list[dict]:
    """Search YouTube like the app's search box (15 results: videoId, title, channel, duration)."""
    return E.search_youtube(query)


@mcp.tool()
def split_song(source: str, model: str = L.MODEL_DEFAULT, stems: list[str] | None = None,
               wait_seconds: float = 0) -> dict:
    """Split a song into stems and add it to the library. source: YouTube URL or 11-char id,
    or a local audio file path. model: 'roformer_hybrid' (default; engine follows the app's
    settings) or 'htdemucs_6s' (adds guitar + piano). stems: only these (default all).
    Reuses an existing split made with the same engine. Runs as a job."""
    jid = jobs.start("split", E.split, source=source, model=model, stems=stems)
    return _wait(jid, wait_seconds)


@mcp.tool()
def job_status(job_id: str, wait_seconds: float = 30) -> dict:
    """Progress / result of a job; blocks up to wait_seconds (max 55) for it to finish."""
    return _wait(job_id, wait_seconds)


@mcp.tool()
def cancel_split(video_id: str | None = None) -> dict:
    """Stop a running split (all running splits when no id is given)."""
    return {"cancelled": E.cancel(video_id)}


@mcp.tool()
def list_songs() -> list[dict]:
    """Songs in the library, newest first."""
    return [{k: s.get(k) for k in ("videoId", "title", "duration", "model", "stems", "source", "key")}
            for s in L.load_songs()]


@mcp.tool()
def get_song(video_id: str) -> dict:
    """One song with absolute paths to its stem WAVs and original mix, plus key, pitch and pan."""
    return L.describe(L.get_song(video_id))


@mcp.tool()
def delete_song(video_id: str) -> dict:
    """Remove a song and its files from the library."""
    L.get_song(video_id)
    L.remove_song(video_id)
    return {"deleted": video_id}


@mcp.tool()
def detect_key(video_id: str) -> dict:
    """(Re)detect the song's key from its pitched stems."""
    s = L.get_song(video_id)
    key = L.patch_key(video_id, E.detect_key(video_id, L.stems_for(s)))
    return {"key": key}


@mcp.tool()
def set_key(video_id: str, key: str | None) -> dict:
    """Override the detected key (e.g. 'E♭', 'F♯m'); null clears the override."""
    return {"key": L.set_key_override(video_id, key)}


@mcp.tool()
def set_pitch(video_id: str, semitones: int) -> dict:
    """Pitch shift the player and exports use for this song (-6..+6 semitones)."""
    return {"semitones": L.save_pitch(video_id, semitones)}


@mcp.tool()
def set_pan(video_id: str, pans: dict[str, float]) -> dict:
    """Per-stem pan, -1 (left) .. 1 (right), e.g. {"guitar": -0.4}. Merged with saved values."""
    return {"pan": L.save_pan(video_id, pans)}


@mcp.tool()
def export_audio(video_id: str, mode: str = "mixed", stems: list[str] | None = None,
                 volumes: dict[str, float] | None = None, pans: dict[str, float] | None = None,
                 semitones: int | None = None, format: str | None = None,
                 dest: str | None = None) -> dict:
    """Export like the app's Export dialog.
    mode: 'mixed' = one file of the chosen stems ('instrumental' when all but vocals),
          'separate' = a folder with one file per chosen stem, 'original' = the full song.
    stems: which stems (default all). volumes: per-stem gain (1 = as is, 0 = muted).
    pans / semitones: default to what the player saved for the song.
    format: wav (32-bit float, lossless) or aac (.m4a); default from settings.
    dest: folder (default ~/Downloads). Returns the written path(s)."""
    return X.export(video_id, mode, stems, volumes, pans, semitones, format, dest)


@mcp.tool()
def get_settings() -> dict:
    """App settings: shifts, htdemucsFt, roformerVocals, gpuSplit, hideVideo, exportFormat,
    exportFolder (auto-export target for every finished split)."""
    return L.load_settings()


@mcp.tool()
def set_settings(patch: dict[str, Any]) -> dict:
    """Change app settings (same validation as the app). Applies to the next split; an open
    StemKit window picks it up after a restart."""
    return L.save_settings(patch)


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
