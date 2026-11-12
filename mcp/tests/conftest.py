"""Shared fixtures: a throwaway StemKit data folder and a fake engine.

The fake engine stands in for the app's venv + python/ scripts (separate.py, roformer.py,
key.py). It speaks the same JSON-lines protocol and writes real WAV files, so splits run
end to end in a second without models or network.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path

import numpy as np
import pytest

HAS_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))
needs_ffmpeg = pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg/ffprobe not on PATH")

SR = 44100


# ------------------------------------------------------------------ audio helpers

def write_wav(path: Path, x: np.ndarray, sr: int = SR) -> Path:
    """Float32 WAV (what the app's separate.py writes). x: (n,) or (n, channels)."""
    x = np.asarray(x, np.float32)
    if x.ndim == 1:
        x = np.stack([x, x], 1)
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(sr), "-ac",
                    str(x.shape[1]), "-i", "-", "-c:a", "pcm_f32le", str(path)],
                   input=x.tobytes(), check=True)
    return path


def read_audio(path: str | Path, sr: int = SR, channels: int = 2) -> np.ndarray:
    """Decode anything ffmpeg reads to float32 (n, channels)."""
    p = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-f", "f32le", "-ac",
                        str(channels), "-ar", str(sr), "-"], capture_output=True, check=True)
    return np.frombuffer(p.stdout, np.float32).reshape(-1, channels)


def probe(path: str | Path) -> dict:
    out = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_streams",
                          "-show_format", str(path)], capture_output=True, check=True).stdout
    return json.loads(out)


def sine(freq: float, seconds: float = 2.0, amp: float = 0.2, sr: int = SR) -> np.ndarray:
    t = np.arange(int(seconds * sr)) / sr
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def level_at(x: np.ndarray, freq: float, sr: int = SR) -> float:
    """Magnitude of the spectrum at freq (mono input), normalised by length."""
    spec = np.abs(np.fft.rfft(x * np.hanning(len(x))))
    k = int(round(freq * len(x) / sr))
    return float(spec[max(0, k - 3): k + 4].max() / len(x))


def peak_freq(x: np.ndarray, sr: int = SR) -> float:
    spec = np.abs(np.fft.rfft(x * np.hanning(len(x))))
    spec[:5] = 0
    return float(np.argmax(spec) * sr / len(x))


STEM_FREQS = {"vocals": 440.0, "drums": 220.0, "bass": 110.0, "other": 330.0,
              "guitar": 550.0, "piano": 660.0}


# ------------------------------------------------------------------ data folder

@pytest.fixture
def data_dir(tmp_path, monkeypatch) -> Path:
    d = tmp_path / "StemKit"
    d.mkdir()
    monkeypatch.setenv("STEMKIT_DATA_DIR", str(d))
    return d


@pytest.fixture
def make_song(data_dir):
    """Put a split song straight into the library: one sine per stem, plus mix.wav."""
    from stemkit_mcp import library as L

    def make(video_id: str = "abcdefghijk", stems=("vocals", "drums", "bass", "other"),
             title: str = "Test Song", seconds: float = 2.0, **extra) -> dict:
        mix = np.zeros(int(seconds * SR), np.float32)
        for s in stems:
            x = sine(STEM_FREQS[s], seconds)
            write_wav(L.stems_dir(video_id) / f"{s}.wav", x)
            mix += x
        write_wav(L.mix_wav(video_id), mix)
        song = {"videoId": video_id, "title": title, "duration": round(seconds), "addedAt": 1,
                "model": "htdemucs", "stems": list(stems), "key": {"detected": "Am"}, **extra}
        L.upsert_song(song)
        return song
    return make


# ------------------------------------------------------------------ fake engine

_FAKE_SEPARATE = r'''
import argparse, json, os, sys, time, wave
from pathlib import Path

def emit(**kw):
    print(json.dumps(kw), flush=True)

ap = argparse.ArgumentParser()
for a in ("--input", "--out", "--model", "--device", "--only", "--ckpt-dir"):
    ap.add_argument(a, default="")
ap.add_argument("--shifts", type=int, default=1)
a = ap.parse_args()
here = Path(__file__).parent
with open(here / "calls.log", "a") as f:
    f.write(json.dumps({"script": Path(__file__).name, "argv": sys.argv[1:]}) + "\n")
if os.environ.get("FAKE_FAIL"):
    emit(type="error", message="fake engine failure")
    sys.exit(1)
emit(type="progress", stage="model", pct=0, message="loading fake model")
for i in range(int(float(os.environ.get("FAKE_SLEEP", "0")) * 10)):
    time.sleep(0.1)
    emit(type="progress", stage="separate", pct=min(99, i))
if Path(__file__).name == "roformer.py":
    wanted = ["vocals"]
elif a.only:
    wanted = a.only.split(",")
elif a.model == "htdemucs_6s":
    wanted = ["vocals", "drums", "bass", "other", "guitar", "piano"]
else:
    wanted = ["vocals", "drums", "bass", "other"]
with wave.open(a.input) as w:
    params, frames = w.getparams(), w.readframes(w.getnframes())
os.makedirs(a.out, exist_ok=True)
for s in wanted:
    with wave.open(os.path.join(a.out, s + ".wav"), "wb") as o:
        o.setparams(params)
        o.writeframes(frames)
    emit(type="stem", name=s)
emit(type="done", stems=wanted, out_dir=a.out)
'''

_FAKE_KEY = r'''
import json, sys
from pathlib import Path
with open(Path(__file__).parent / "calls.log", "a") as f:
    f.write(json.dumps({"script": "key.py", "argv": sys.argv[1:]}) + "\n")
print(json.dumps({"type": "key", "tonic": 9, "mode": "minor"}), flush=True)
'''


class FakeEngine:
    def __init__(self, scripts: Path):
        self.scripts = scripts

    def calls(self, script: str | None = None) -> list[dict]:
        log = self.scripts / "calls.log"
        rows = [json.loads(x) for x in log.read_text().splitlines()] if log.exists() else []
        return [r for r in rows if script is None or r["script"] == script]


@pytest.fixture
def fake_engine(data_dir, tmp_path, monkeypatch) -> FakeEngine:
    from stemkit_mcp import paths
    py = paths.venv_python()
    py.parent.mkdir(parents=True)
    os.symlink(sys.executable, py)
    scripts = tmp_path / "scripts"
    scripts.mkdir()
    (scripts / "separate.py").write_text(textwrap.dedent(_FAKE_SEPARATE))
    (scripts / "roformer.py").write_text(textwrap.dedent(_FAKE_SEPARATE))
    (scripts / "key.py").write_text(textwrap.dedent(_FAKE_KEY))
    monkeypatch.setenv("STEMKIT_SCRIPTS", str(scripts))
    monkeypatch.delenv("FAKE_FAIL", raising=False)
    monkeypatch.delenv("FAKE_SLEEP", raising=False)
    return FakeEngine(scripts)


@pytest.fixture
def song_file(tmp_path) -> Path:
    """A local audio file to split."""
    return write_wav(tmp_path / "in" / "My Song.wav", sine(220, 1.0) + sine(440, 1.0))
