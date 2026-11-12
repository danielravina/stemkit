"""Library contracts: same files and rules as src/main/library.ts + settings.ts.

Cases marked "app:" are ported from the app's own tests (tests/*-storage.test.mjs) or its
source, so the app and the MCP server agree on what they write to the shared folder.
"""

from __future__ import annotations

import json
import threading

import pytest

from stemkit_mcp import library as L
from stemkit_mcp.paths import StemKitError

SONG = {"videoId": "song-one", "stems": ["vocals", "drums"], "title": "Test", "duration": 10,
        "addedAt": 1}


@pytest.fixture
def lib(data_dir):
    L.save_songs([dict(SONG), {**SONG, "videoId": "song-two"}])
    L.song_dir("song-one").mkdir(parents=True)
    return data_dir


# ------------------------------------------------------------------ ids / paths

@pytest.mark.parametrize("bad", ["", "../escape", "a/b", "a\\b", "..", "x y"])
def test_song_dir_rejects_anything_but_plain_ids(data_dir, bad):
    with pytest.raises(StemKitError, match="Unknown song"):
        L.song_dir(bad)


def test_song_dir_stays_inside_the_library(data_dir):
    assert L.song_dir("local-0a1b2c3d").parent == data_dir / "songs"


# ------------------------------------------------------------------ library.json

def test_missing_or_corrupt_library_reads_as_empty(data_dir):
    assert L.load_songs() == []
    L.library_file().write_text("{broken")
    assert L.load_songs() == []
    L.library_file().write_text(json.dumps({"songs": "nope"}))
    assert L.load_songs() == []


def test_upsert_puts_newest_first_and_replaces(data_dir):
    L.upsert_song({"videoId": "a"})
    L.upsert_song({"videoId": "b"})
    L.upsert_song({"videoId": "a", "title": "again"})
    assert [s["videoId"] for s in L.load_songs()] == ["a", "b"]
    assert L.load_songs()[0]["title"] == "again"


def test_writes_are_atomic_json(data_dir):
    L.upsert_song({"videoId": "a", "title": "Ünïcødé ♯"})
    raw = L.library_file().read_text(encoding="utf-8")
    assert json.loads(raw) == {"songs": [{"videoId": "a", "title": "Ünïcødé ♯"}]}
    assert "♯" in raw                                   # ensure_ascii off, like JSON.stringify
    assert not list(data_dir.glob(".stemkit-*"))       # no temp files left behind


def test_concurrent_writers_in_process_lose_nothing(data_dir):
    """Split jobs and tool calls run on different threads; none of their writes may be lost."""
    L.save_songs([{"videoId": "base", "key": {"detected": "C"}}])

    def add(i):
        L.upsert_song({"videoId": f"s{i:03d}"})

    def key(_):
        L.set_key_override("base", "Am")

    ts = [threading.Thread(target=add if i % 2 else key, args=(i,)) for i in range(80)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    ids = {s["videoId"] for s in L.load_songs()}
    assert ids == {"base"} | {f"s{i:03d}" for i in range(1, 80, 2)}


def test_remove_song_deletes_entry_and_files(lib):
    (L.song_dir("song-one") / "pan.json").write_text("{}")
    L.remove_song("song-one")
    assert [s["videoId"] for s in L.load_songs()] == ["song-two"]
    assert not L.song_dir("song-one").exists()


def test_get_song_unknown(lib):
    with pytest.raises(StemKitError, match="Unknown song"):
        L.get_song("nope")


# ------------------------------------------------------------------ describe

def test_describe_gives_absolute_existing_paths(lib):
    d = L.stems_dir("song-one")
    d.mkdir()
    (d / "vocals.wav").write_bytes(b"x")              # drums.wav missing on purpose
    out = L.describe(L.get_song("song-one"))
    assert out["stem_files"] == {"vocals": str(d / "vocals.wav")}
    assert out["mix"] is None
    assert out["url"] == "https://www.youtube.com/watch?v=song-one"
    assert out["pitch"] == 0 and out["pan"] == {}


def test_describe_local_song_has_no_url_and_override_wins(data_dir):
    s = {"videoId": "local-00000001", "source": "local", "stems": ["drums"],
         "key": {"detected": "C", "override": "Am"}}
    out = L.describe(s)
    assert out["url"] is None
    assert out["key_effective"] == "Am"
    assert L.describe({**s, "key": {"detected": "C"}})["key_effective"] == "C"


def test_stems_for_defaults(data_dir):
    assert L.stems_for(None) == L.DEFAULT_STEMS
    assert L.stems_for({"stems": []}) == L.DEFAULT_STEMS
    assert L.stems_for({"stems": ["drums"]}) == ["drums"]


# ------------------------------------------------------------------ pan (app: tests/pan-storage.test.mjs)

def test_pan_app_cases(lib):
    assert L.load_pan("song-one") == {}
    assert L.save_pan("song-one", {"vocals": -0.5, "drums": 3, "other": 0.8}) == \
        {"vocals": -0.5, "drums": 1.0}
    assert L.load_pan("song-one") == {"vocals": -0.5, "drums": 1.0}
    assert L.load_pan("song-two") == {}
    (L.song_dir("song-one") / "pan.json").write_text("{broken")
    assert L.load_pan("song-one") == {}
    with pytest.raises(StemKitError, match="Unknown song"):
        L.save_pan("../escape", {})


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf"), "left", True, None, [1]])
def test_pan_rejects_non_numbers_like_js(lib, bad):
    """typeof x === 'number' && Number.isFinite(x): bools, strings, NaN and ±Infinity are dropped."""
    assert L._normalize_pan(SONG, {"vocals": bad}) == {}


def test_pan_merges_with_saved_values(lib):
    L.save_pan("song-one", {"vocals": -0.5})
    assert L.save_pan("song-one", {"drums": 0.25}) == {"vocals": -0.5, "drums": 0.25}


def test_pan_ignores_non_objects(lib):
    for v in ([0.5], "x", 3, None):
        assert L._normalize_pan(SONG, v) == {}


# ------------------------------------------------------------------ pitch (app: src/shared/pitch-range.ts)

@pytest.mark.parametrize("given,want", [
    (0, 0), (3, 3), (-3, -3), (6, 6), (7, 6), (99, 6), (-7, -6), (-99, -6),
    (2.4, 2), (2.5, 3), (-2.5, -2), (-0.4, 0), (0.5, 1), (-0.5, 0),     # Math.round: halves up
    (float("nan"), 0), (float("inf"), 0), (float("-inf"), 0),
    ("3", 0), (None, 0), (True, 0), (False, 0),
])
def test_clamp_pitch(given, want):
    got = L.clamp_pitch(given)
    assert got == want and isinstance(got, int)


def test_pitch_round_trip_and_bad_files(lib):
    assert L.load_pitch("song-one") == 0
    assert L.save_pitch("song-one", 9) == 6
    assert L.load_pitch("song-one") == 6
    (L.song_dir("song-one") / "pitch.json").write_text('{"semitones": "x"}')
    assert L.load_pitch("song-one") == 0
    with pytest.raises(StemKitError):
        L.save_pitch("missing", 1)


# ------------------------------------------------------------------ key (app: tests/key-storage.test.mjs)

def test_key_override_set_and_clear(lib):
    L.patch_key("song-one", "C")
    assert L.set_key_override("song-one", "F♯m") == {"detected": "C", "override": "F♯m"}
    assert L.set_key_override("song-one", None) == {"detected": "C"}
    with pytest.raises(StemKitError, match="Unknown key"):
        L.set_key_override("song-one", "H")
    with pytest.raises(StemKitError, match="Unknown song"):
        L.set_key_override("nope", "C")


def test_redetect_keeps_override(lib):
    L.set_key_override("song-one", "Am")
    assert L.patch_key("song-one", "G") == {"detected": "G", "override": "Am"}
    assert L.patch_key("nope", "G") is None


def test_key_names_cover_all_24_keys():
    assert len(L.KEY_NAMES) == 24 == len(set(L.KEY_NAMES))
    assert L.key_name(0, "major") == "C" and L.key_name(9, "minor") == "Am"
    assert L.key_name(-1, "major") == "B" and L.key_name(13, "minor") == "C♯m"


# ------------------------------------------------------------------ settings (app: src/main/settings.ts)

def test_settings_defaults_and_corrupt_file(data_dir):
    assert L.load_settings() == L.DEFAULT_SETTINGS
    L.settings_file().write_text("[1, 2]")
    assert L.load_settings() == L.DEFAULT_SETTINGS
    L.settings_file().write_text("{broken")
    assert L.load_settings() == L.DEFAULT_SETTINGS


def test_settings_validation_matches_app(data_dir):
    out = L.save_settings({"shifts": 2, "htdemucsFt": 1, "roformerVocals": "yes", "gpuSplit": 0,
                           "hideVideo": [], "exportFormat": "mp3", "exportFolder": "  /x  ",
                           "bogus": True})
    # JS !!: 1 / "yes" / [] are truthy, 0 is falsy; unknown keys are dropped
    assert out == {"shifts": 2, "htdemucsFt": True, "roformerVocals": True,
                   "gpuSplit": False, "hideVideo": True, "exportFormat": "wav",
                   "exportFolder": "/x"}
    assert json.loads(L.settings_file().read_text()) == out
    assert L.save_settings({"shifts": 3})["shifts"] == 1
    assert L.save_settings({"shifts": True})["shifts"] == 1
    assert L.save_settings({"exportFormat": "aac"})["exportFormat"] == "aac"
    assert L.save_settings({"exportFolder": 5})["exportFolder"] == ""
    assert L.save_settings({"gpuSplit": float("nan")})["gpuSplit"] is False


def test_settings_patch_keeps_other_values(data_dir):
    L.save_settings({"shifts": 2, "exportFormat": "aac"})
    assert L.save_settings({"gpuSplit": True}) == {
        **L.DEFAULT_SETTINGS, "shifts": 2, "exportFormat": "aac", "gpuSplit": True}


# ------------------------------------------------------------------ export names (app: tests/export-rules.test.mjs)

def test_export_names():
    allst = ["vocals", "drums", "bass", "other"]
    assert L.mixed_base_name("Song", ["drums", "bass", "other"], allst, 0) == "Song - instrumental"
    assert L.mixed_base_name("Song", ["bass", "drums"], allst, 0) == "Song - drums+bass"
    assert L.mixed_base_name("Song", ["drums"], allst, -2) == "Song - drums (-2)"
    assert L.separate_folder_name("Song", 3) == "Song (+3)"
    assert L.original_mix_name("Song", 0) == "Song"
    long = "x" * 200
    name = L.mixed_base_name(long, ["drums", "bass"], allst, 2)
    assert len(name) == 120 and name.endswith(" - drums+bass (+2)")


@pytest.mark.parametrize("given,want", [
    ('a/b\\c:d*e?f"g<h>i|j', "a-b-c-d-e-f-g-h-i-j"), ("  x  ", "x"), ("", "stems"),
    ("   ", "stems"), (".", "stems"), ("..", "stems"), ("../..", "..-.."), ("y" * 130, "y" * 120),
])
def test_sanitize_name(given, want):
    assert L.sanitize_name(given) == want


def test_names_count_utf16_units_like_js():
    """'🥁' is one Python character but two JS units; limits are in JS units."""
    assert L.sanitize_name("🥁" * 70) == "🥁" * 60
    name = L.mixed_base_name("🥁" * 70, ["drums"], ["vocals", "drums", "bass"], 0)
    assert name == "🥁" * 56 + " - drums"     # 120 - len(" - drums") = 112 units = 56 drums
