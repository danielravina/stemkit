"""Differential tests: the Python copies give the same answers as the app's TypeScript.

Runs src/shared/*.ts and src/main/library.ts under node (ts_eval.mjs) on the same inputs.
Skipped when node is not installed or the app sources are not next to mcp/.
"""

from __future__ import annotations

import json
import math
import random
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from stemkit_mcp import engine as E
from stemkit_mcp import library as L

HERE = Path(__file__).parent
SRC = HERE.parents[1] / "src"
NODE = shutil.which("node")
pytestmark = pytest.mark.skipif(not NODE or not (SRC / "shared" / "local.ts").exists(),
                                reason="needs node and the StemKit app sources")


def _enc(v):
    if isinstance(v, float) and not math.isfinite(v):
        return {"$n": "NaN" if v != v else ("Infinity" if v > 0 else "-Infinity")}
    if isinstance(v, list):
        return [_enc(x) for x in v]
    if isinstance(v, dict):
        return {k: _enc(x) for k, x in v.items()}
    return v


def ts(calls: list[tuple[str, list]], root: Path) -> list:
    p = subprocess.run([NODE, "--experimental-strip-types", "--no-warnings", str(HERE / "ts_eval.mjs")],
                       input=json.dumps({"root": str(root), "calls": _enc([list(c) for c in calls])}),
                       capture_output=True, text=True, timeout=60)
    assert p.returncode == 0, p.stderr
    return json.loads(p.stdout)


_LONE_SURROGATE = re.compile("\\s*[\ud800-\udfff]")


def whole_chars(v):
    """The app's 120-unit cut can split an emoji and leave half of it (a lone UTF-16
    surrogate, not a valid file name on Linux/macOS). The Python side drops the half
    character (then trims, as the app would have); compare modulo that one difference."""
    return _LONE_SURROGATE.sub("", v) if isinstance(v, str) else v


def compare(name: str, py_fn, argsets: list[list], tmp_path, fix=lambda v: v) -> None:
    want = [fix(w) for w in ts([(name, a) for a in argsets], tmp_path)]
    got = [py_fn(*a) for a in argsets]
    bad = [(a, g, w) for a, g, w in zip(argsets, got, want, strict=True) if g != w]
    assert not bad, "python != app for:\n" + "\n".join(f"  {a!r}: {g!r} != {w!r}" for a, g, w in bad[:10])


def _strings(n: int, seed: int) -> list[str]:
    rnd = random.Random(seed)
    alphabet = "abcXYZ019 _-./\\:*?\"<>|éßñ♯♭🥁🎸日本\t"
    out = ["", " ", ".", "..", "  padded  ", "/home/me/Music/Song (live).mp3",
           "C:\\Users\\me\\Music\\x.wav", "🥁" * 70, "a" * 130, "日本語のタイトル" * 20]
    out += ["".join(rnd.choice(alphabet) for _ in range(rnd.randint(1, 140))) for _ in range(n)]
    return out


def test_constants(tmp_path):
    keys, exts = ts([("KEY_NAMES", []), ("AUDIO_EXTENSIONS", [])], tmp_path)
    assert keys == L.KEY_NAMES
    assert set(exts) == E.AUDIO_EXTENSIONS


def test_local_song_id(tmp_path):
    compare("localSongId", E.local_song_id, [[s] for s in _strings(200, 1)], tmp_path)


def test_parse_video_id(tmp_path):
    cases = ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "youtu.be/dQw4w9WgXcQ",
             "https://m.youtube.com/watch?feature=share&v=dQw4w9WgXcQ", "dQw4w9WgXcQ",
             " dQw4w9WgXcQ\n", "dQw4w9WgXc", "https://youtube.com/shorts/dQw4w9WgXcQ?x",
             "https://www.youtube.com/embed/dQw4w9WgXcQ", "https://vimeo.com/123", "",
             "aaaaaaaaaaa", "aaaaaaaaaaaa", "watch?v=dQw4w9WgXcQ"]
    compare("parseVideoId", E.parse_video_id, [[s] for s in cases + _strings(50, 2)], tmp_path)


def test_clamp_pitch(tmp_path):
    vals = [0, 1, -1, 6, 7, -7, 100, -100, 0.5, -0.5, 1.5, -1.5, 2.5, -2.5, 2.4999, -0.4,
            5.5, -6.5, float("nan"), float("inf"), float("-inf"), "3", None, True, False, [2]]
    compare("clampPitch", L.clamp_pitch, [[v] for v in vals], tmp_path)


def test_key_name(tmp_path):
    compare("keyName", L.key_name, [[t, m] for t in range(-13, 26) for m in ("major", "minor")],
            tmp_path)


def test_sanitize_name(tmp_path):
    compare("sanitizeName", L.sanitize_name, [[s] for s in _strings(200, 3)], tmp_path, fix=whole_chars)


def test_export_names(tmp_path):
    rnd = random.Random(4)
    stem_sets = [["vocals", "drums", "bass", "other"],
                 ["vocals", "drums", "bass", "other", "guitar", "piano"], ["drums", "bass"]]
    cases = []
    for title in _strings(40, 5):
        allst = rnd.choice(stem_sets)
        sel = [s for s in allst if rnd.random() < 0.6] or [allst[0]]
        semis = rnd.randint(-6, 6)
        cases.append([title, sel, allst, semis])
    cases.append(["Song", ["drums", "bass", "other"], stem_sets[0], 0])          # instrumental
    compare("mixedBaseName", L.mixed_base_name, cases, tmp_path, fix=whole_chars)
    compare("separateFolderName", L.separate_folder_name, [[c[0], c[3]] for c in cases], tmp_path, fix=whole_chars)
    compare("originalMixName", L.original_mix_name, [[c[0], c[3]] for c in cases], tmp_path, fix=whole_chars)


def test_normalize_pan(tmp_path):
    (tmp_path / "songs" / "p").mkdir(parents=True)
    song = {"videoId": "p", "stems": ["vocals", "drums", "bass", "other", "kazoo"]}
    values = [{"vocals": -0.5, "drums": 3, "other": 0.8, "piano": 1},
              {"vocals": float("nan"), "drums": float("inf"), "bass": "left"},
              {"vocals": True, "drums": False, "bass": None, "other": [1]},
              {"kazoo": 0.5, "vocals": -1, "drums": 1, "bass": -7},
              [0.5], "x", 3, None, {}]
    want = ts([("normalizePan", [song, v]) for v in values], tmp_path)
    got = [L._normalize_pan(song, v) for v in values]
    assert got == want
