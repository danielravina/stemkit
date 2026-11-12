"""Fixtures for the make-cover scripts: a synthetic song folder and play-along videos."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(HERE))

import cover_synth as S  # noqa: E402

needs_ffmpeg = pytest.mark.skipif(not (shutil.which("ffmpeg") and shutil.which("ffprobe")),
                                  reason="ffmpeg/ffprobe not on PATH")


@pytest.fixture(autouse=True)
def _cache(tmp_path, monkeypatch):
    """Keep cover.py's per-video cache out of ~/.cache."""
    monkeypatch.setenv("STEMKIT_COVER_CACHE", str(tmp_path / "cache"))


@pytest.fixture(scope="session")
def song_dir(tmp_path_factory) -> Path:
    return S.make_song_dir(tmp_path_factory.mktemp("song"))


@pytest.fixture(scope="session")
def camera():
    return S.make_camera()


@pytest.fixture(scope="session", params=[0.0, 0.5], ids=["audio@0", "audio@0.5"])
def take(request, tmp_path_factory, camera):
    """(video path, audio start offset)."""
    d = tmp_path_factory.mktemp("take")
    return S.make_video(d / "take.mp4", camera, request.param), request.param


def run_cover(*args: str, check: bool = True) -> dict:
    """Run cover.py like the skill does; returns its stdout JSON (+ 'returncode')."""
    p = subprocess.run([sys.executable, str(SCRIPTS / "cover.py"), *map(str, args)],
                       capture_output=True, text=True, timeout=600)
    out = json.loads(p.stdout) if p.stdout.strip() else {}
    out["returncode"] = p.returncode
    if check and p.returncode != 0:
        raise AssertionError(f"cover.py {args} failed: {p.stdout}\n{p.stderr[-2000:]}")
    return out
