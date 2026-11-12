"""export_audio contracts (app: src/renderer/src/lib/exporter.ts + render-math.ts).

Contract for export(video_id, mode, stems, volumes, pans, semitones, fmt, dest, overwrite):
  pre   mode in mixed|separate|original; stems/volumes/pans name stems the song has;
        volumes >= 0, pans in -1..1; fmt wav|aac. Checked before anything is written.
  post  wav: 44.1 kHz, stereo, 32-bit float. aac: .m4a, 256k.
        chain per stem: gain -> Web Audio StereoPanner -> sum -> pitch shift; scaled down only
        if the peak would pass 1.0 (to 0.98855), never otherwise.
        names follow export-rules.ts; existing files are never replaced unless overwrite.
        pans / semitones default to what the player saved for the song.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import numpy as np
import pytest

from stemkit_mcp import exporter as X
from stemkit_mcp import library as L
from stemkit_mcp.paths import StemKitError

from .conftest import STEM_FREQS, level_at, needs_ffmpeg, peak_freq, probe, read_audio

pytestmark = needs_ffmpeg
VID = "abcdefghijk"


@pytest.fixture
def song(make_song):
    return make_song(VID)


@pytest.fixture
def out(tmp_path) -> Path:
    return tmp_path / "exports"


def stream(path) -> dict:
    return probe(path)["streams"][0]


def sha(path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


# ------------------------------------------------------------------ format and names

def test_mixed_all_stems_format_and_name(song, out):
    r = X.export(VID, dest=str(out))
    assert r["path"] == str(out / "Test Song - vocals+drums+bass+other.wav")
    assert r["stems"] == ["vocals", "drums", "bass", "other"] and r["format"] == "wav"
    st = stream(r["path"])
    assert (st["codec_name"], st["sample_rate"], st["channels"]) == ("pcm_f32le", "44100", 2)
    assert abs(float(st["duration"]) - 2.0) < 0.01
    x = read_audio(r["path"]).mean(1)
    for f in STEM_FREQS.values():
        if f in (440, 220, 110, 330):
            assert level_at(x, f) > 0.03


def test_instrumental_name_and_content(song, out):
    r = X.export(VID, stems=["drums", "bass", "other"], dest=str(out))
    assert Path(r["path"]).name == "Test Song - instrumental.wav"
    x = read_audio(r["path"]).mean(1)
    assert level_at(x, 440) < 1e-3 < level_at(x, 220)


def test_stem_order_follows_song_not_request(song, out):
    r = X.export(VID, stems=["bass", "drums"], dest=str(out))
    assert Path(r["path"]).name == "Test Song - drums+bass.wav"


def test_aac(song, out):
    r = X.export(VID, stems=["drums"], fmt="aac", dest=str(out))
    assert r["path"].endswith("Test Song - drums.m4a")
    st = stream(r["path"])
    assert st["codec_name"] == "aac" and st["sample_rate"] == "44100"


def test_format_defaults_to_settings(song, out):
    L.save_settings({"exportFormat": "aac"})
    assert X.export(VID, stems=["drums"], dest=str(out))["path"].endswith(".m4a")


def test_separate(song, out):
    r = X.export(VID, mode="separate", stems=["drums", "vocals"], dest=str(out))
    assert r["path"] == str(out / "Test Song") and r["count"] == 2
    assert [Path(p).name for p in r["files"]] == ["vocals.wav", "drums.wav"]
    x = read_audio(r["files"][1]).mean(1)
    assert level_at(x, 220) > 0.03 and level_at(x, 440) < 1e-3


def test_original(song, out):
    r = X.export(VID, mode="original", dest=str(out))
    assert r["path"] == str(out / "Test Song.wav")
    x = read_audio(r["path"]).mean(1)
    assert all(level_at(x, f) > 0.03 for f in (110, 220, 330, 440))


def test_title_is_sanitized(make_song, out):
    make_song(VID, stems=("drums",), title='AC/DC: "Back" <In> Black?')
    r = X.export(VID, dest=str(out))
    assert Path(r["path"]).name == "AC-DC- -Back- -In- Black- - drums.wav"
    assert Path(r["path"]).parent == out


def test_default_dest_is_downloads(song, tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    r = X.export(VID, stems=["drums"])
    assert Path(r["path"]).parent == tmp_path / "home" / "Downloads"


# ------------------------------------------------------------------ never overwrite

def test_existing_files_are_kept(song, out):
    a = X.export(VID, stems=["drums"], dest=str(out))["path"]
    h = sha(a)
    b = X.export(VID, stems=["drums"], volumes={"drums": 0.5}, dest=str(out))["path"]
    c = X.export(VID, stems=["drums"], dest=str(out))["path"]
    assert Path(b).name == "Test Song - drums (2).wav"
    assert Path(c).name == "Test Song - drums (3).wav"
    assert sha(a) == h


def test_overwrite_replaces(song, out):
    a = X.export(VID, stems=["drums"], dest=str(out))["path"]
    b = X.export(VID, stems=["drums"], volumes={"drums": 0.5}, dest=str(out), overwrite=True)["path"]
    assert a == b and len(list(out.iterdir())) == 1


def test_separate_folder_is_kept(song, out):
    a = X.export(VID, mode="separate", stems=["drums"], dest=str(out))
    b = X.export(VID, mode="separate", stems=["drums"], dest=str(out))
    assert Path(b["path"]).name == "Test Song (2)"
    assert Path(a["files"][0]).exists() and Path(b["files"][0]).exists()


def test_no_temp_files_left(song, out):
    X.export(VID, mode="separate", dest=str(out))
    X.export(VID, dest=str(out))
    assert not [p for p in out.iterdir() if p.name.startswith(".stemkit-")]


# ------------------------------------------------------------------ the audio chain

def test_volume_zero_mutes_a_stem(song, out):
    x = read_audio(X.export(VID, volumes={"drums": 0}, dest=str(out))["path"]).mean(1)
    assert level_at(x, 220) < 1e-4 < level_at(x, 440)


def test_volume_scales_linearly(song, out):
    one = read_audio(X.export(VID, stems=["drums"], dest=str(out))["path"])
    half = read_audio(X.export(VID, stems=["drums"], volumes={"drums": 0.5}, dest=str(out))["path"])
    assert np.allclose(half, one * 0.5, atol=1e-5)


def test_no_scaling_when_it_does_not_clip(song, out):
    x = read_audio(X.export(VID, stems=["drums"], dest=str(out))["path"])
    assert abs(np.abs(x).max() - 0.2) < 1e-3


def test_scaled_down_only_when_it_would_clip(song, out):
    x = read_audio(X.export(VID, volumes={s: 4 for s in ("vocals", "drums", "bass", "other")},
                            dest=str(out))["path"])
    assert X.CEILING - 1e-3 < np.abs(x).max() <= X.CEILING + 1e-4


@pytest.mark.parametrize("pan,left,right", [
    (-1.0, 2.0, 0.0),                                    # hard left: right folds into left
    (1.0, 0.0, 2.0),
    (0.0, 1.0, 1.0),                                     # centre: untouched
    (-0.5, 1 + np.cos(np.pi / 4), np.sin(np.pi / 4)),    # StereoPannerNode, stereo input
])
def test_pan_law_matches_web_audio(song, out, pan, left, right):
    """Web Audio StereoPannerNode on a stereo source (pan <= 0: L += cos(x)·R, R *= sin(x),
    x = (pan + 1)·π/2)."""
    x = read_audio(X.export(VID, stems=["vocals"], pans={"vocals": pan}, dest=str(out),
                            overwrite=True)["path"])
    peak = 0.2
    assert abs(np.abs(x[:, 0]).max() - peak * left) < 2e-3
    assert abs(np.abs(x[:, 1]).max() - peak * right) < 2e-3


def test_saved_pan_and_pitch_are_the_defaults(song, out):
    L.save_pan(VID, {"vocals": -1})
    L.save_pitch(VID, 0)
    x = read_audio(X.export(VID, stems=["vocals"], dest=str(out))["path"])
    assert np.abs(x[:, 1]).max() < 1e-4
    # an explicit pans argument is merged over the saved values
    y = read_audio(X.export(VID, stems=["vocals"], pans={"vocals": 0}, dest=str(out))["path"])
    assert np.abs(y[:, 1]).max() > 0.19


@pytest.mark.parametrize("semis", [-5, 3])
def test_pitch_shift_moves_frequency_keeps_length(song, out, semis):
    r = X.export(VID, stems=["vocals"], semitones=semis, dest=str(out))
    assert Path(r["path"]).name == f"Test Song - vocals ({'+' if semis > 0 else '-'}{abs(semis)}).wav"
    assert r["semitones"] == semis
    x = read_audio(r["path"]).mean(1)
    want = 440 * 2 ** (semis / 12)
    mid = x[len(x) // 4: 3 * len(x) // 4]
    assert abs(peak_freq(mid) - want) < want * 0.01
    assert abs(len(x) / 44100 - 2.0) < 0.05


def test_pitch_is_clamped(song, out):
    assert X.export(VID, stems=["drums"], semitones=40, dest=str(out))["semitones"] == 6


def test_saved_pitch_is_the_default(song, out):
    L.save_pitch(VID, -2)
    r = X.export(VID, stems=["drums"], dest=str(out))
    assert r["semitones"] == -2 and r["path"].endswith("(-2).wav")


# ------------------------------------------------------------------ checked before writing

@pytest.mark.parametrize("kwargs,msg", [
    ({"mode": "mix"}, "mode must be"),
    ({"stems": ["guitar"]}, "has no"),
    ({"stems": []}, "at least one stem"),
    ({"volumes": {"drums": -1}}, "volumes"),
    ({"volumes": {"drums": float("nan")}}, "volumes"),
    ({"volumes": {"drums": "loud"}}, "volumes"),
    ({"volumes": {"kazoo": 1}}, "no 'kazoo' stem"),
    ({"pans": {"drums": 2}}, "pans"),
    ({"pans": {"piano": 0}}, "no 'piano' stem"),
    ({"fmt": "mp3"}, "format"),
    ({"semitones": "up"}, "semitones"),
])
def test_bad_arguments_write_nothing(song, out, kwargs, msg):
    with pytest.raises(StemKitError, match=msg):
        X.export(VID, dest=str(out), **kwargs)
    assert not out.exists()


def test_unknown_song(data_dir, out):
    with pytest.raises(StemKitError, match="Unknown song"):
        X.export("nope", dest=str(out))


def test_missing_stem_file(song, out):
    (L.stems_dir(VID) / "bass.wav").unlink()
    with pytest.raises(StemKitError, match="missing on disk"):
        X.export(VID, dest=str(out))
    X.export(VID, stems=["drums"], dest=str(out))        # the others still export


def test_original_without_mix(song, out):
    L.mix_wav(VID).unlink()
    with pytest.raises(StemKitError, match="no original mix"):
        X.export(VID, mode="original", dest=str(out))
    assert not out.exists()


# ------------------------------------------------------------------ auto-export copy

def test_copy_to_export_folder(song, tmp_path):
    r = X.copy_to_export_folder(VID, str(tmp_path / "auto"), "wav")
    assert r["count"] == 5
    assert sha(tmp_path / "auto" / "Test Song" / "drums.wav") == sha(L.stems_dir(VID) / "drums.wav")
    r = X.copy_to_export_folder(VID, str(tmp_path / "auto2"), "aac")
    assert stream(tmp_path / "auto2" / "Test Song" / "Test Song.m4a")["codec_name"] == "aac"
