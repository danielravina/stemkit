"""Where StemKit keeps things. Mirrors src/main/env.ts + data-dir.ts."""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

from mcp.server.mcpserver.exceptions import ToolError

IS_WIN = os.name == "nt"


class StemKitError(ToolError):
    """An expected failure with a message for the user. Subclassing ToolError is what lets
    the message reach the MCP client: the SDK replaces any other exception's text with
    'Error executing tool <name>'."""


def data_dir() -> Path:
    """STEMKIT_DATA_DIR, else Electron's userData folder for the app."""
    override = (os.environ.get("STEMKIT_DATA_DIR") or "").strip()
    if override:
        return Path(override).expanduser().resolve()
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "StemKit"
    if IS_WIN:
        return Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming")) / "StemKit"
    return Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "StemKit"


def venv_dir() -> Path:
    return data_dir() / "venv"


def venv_python() -> Path:
    return venv_dir() / ("Scripts" if IS_WIN else "bin") / ("python.exe" if IS_WIN else "python")


def venv_ytdlp() -> Path:
    return venv_dir() / ("Scripts" if IS_WIN else "bin") / ("yt-dlp.exe" if IS_WIN else "yt-dlp")


def models_dir() -> Path:
    return data_dir() / "models"


def scripts_dir() -> Path:
    """The app's python/ folder (separate.py, roformer.py, key.py)."""
    cands = []
    if os.environ.get("STEMKIT_SCRIPTS"):
        cands.append(Path(os.environ["STEMKIT_SCRIPTS"]).expanduser())
    cands.append(Path(__file__).resolve().parents[2] / "python")          # repo checkout
    if sys.platform == "darwin":
        cands.append(Path("/Applications/StemKit.app/Contents/Resources/python"))
    if IS_WIN:
        la = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
        cands.append(la / "Programs" / "StemKit" / "resources" / "python")
    for c in cands:
        if (c / "separate.py").exists():
            return c
    raise StemKitError("Could not find StemKit's python scripts (separate.py). Run from a StemKit "
                       "checkout or set STEMKIT_SCRIPTS to the app's resources/python folder.")


def ffmpeg() -> str:
    exe = os.environ.get("STEMKIT_FFMPEG") or shutil.which("ffmpeg")
    if not exe:
        raise StemKitError("ffmpeg not found: install it or set STEMKIT_FFMPEG")
    return exe


def js_runtime_args() -> list[str]:
    """yt-dlp needs a JS runtime for YouTube; the app passes the one it found."""
    for kind in ("deno", "node", "bun"):
        p = shutil.which(kind)
        if p:
            return ["--js-runtimes", f"{kind}:{p}"]
    return []


def require_engine() -> None:
    if not venv_python().exists():
        raise StemKitError(f"StemKit's engine is not installed at {venv_dir()}. Open StemKit once "
                           "and let it finish setup (or set STEMKIT_DATA_DIR).")
