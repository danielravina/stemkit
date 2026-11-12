"""Sync and cut contracts (coverkit/sync.py), on a song whose answer is known.

Contract for analyze(video, song_dir, instrument):
  post  song time = video time + song_offset_at_video_start, within 5 ms, on the right bar;
        entry/stop in video time account for the audio stream's start offset;
        the cut lands just before the next section when one starts near the end, else
        1.5 s after the playing stops; never past the end of the video.
"""

from __future__ import annotations

import numpy as np
import pytest

import cover_synth as S
from conftest import needs_ffmpeg, run_cover
from coverkit import sync as Y

pytestmark = needs_ffmpeg


@pytest.fixture(scope="module")
def analyses(request):
    return {}


def analyze(take, song_dir, cache: dict) -> dict:
    video, a0 = take
    if a0 not in cache:
        cache[a0] = run_cover("analyze", video, "--song-dir", song_dir, "--instrument", "drums")
    return cache[a0]


def test_finds_the_offset_to_the_millisecond(take, song_dir, analyses):
    """What places the song under the picture: song time = video time + offset. (lag_cam is
    relative to the audio stream's reported start, which AAC priming can shift by ~20 ms;
    the two cancel, so the offset is the quantity to hold to 5 ms.)"""
    video, a0 = take
    a = analyze(take, song_dir, analyses)
    assert abs(a["song_offset_at_video_start"] - (S.LAG - a0)) <= 0.005, a["sync"]["candidates"]


def test_lands_on_the_right_bar_with_margin(take, song_dir, analyses):
    a = analyze(take, song_dir, analyses)
    assert a["sync"]["confidence"] is not None and a["sync"]["confidence"] >= 1.5, a["sync"]
    alts = [c["lag"] for c in a["sync"]["bar_alternatives"]]
    assert alts and all(abs((x - a["sync"]["coarse_lag"]) / S.BAR - round((x - a["sync"]["coarse_lag"]) / S.BAR)) < 0.1
                        for x in alts)


def test_tempo(take, song_dir, analyses):
    assert abs(analyze(take, song_dir, analyses)["sync"]["bpm"] - 120) <= 1


def test_entry_and_stop_in_video_and_song_time(take, song_dir, analyses):
    video, a0 = take
    a = analyze(take, song_dir, analyses)
    assert a["audio_start"] == pytest.approx(a0, abs=0.03)
    assert a["entry_video"] == pytest.approx(S.CAM_LEAD + a0, abs=0.15)
    assert a["entry_song"] == pytest.approx(S.PLAY[0], abs=0.15)
    assert a["stop_video"] == pytest.approx(S.CAM_LEAD + (S.PLAY[1] - S.PLAY[0]) + a0, abs=0.5)
    assert a["song_offset_at_video_start"] == pytest.approx(a["lag_cam"] - a["audio_start"], abs=1e-3)


def test_cut_just_before_the_next_section(take, song_dir, analyses):
    video, a0 = take
    a = analyze(take, song_dir, analyses)
    want = S.OUTRO - 0.1 - S.LAG + a0
    assert a["cut_video"] == pytest.approx(want, abs=0.1), a["boundary"]
    assert "next song section" in a["cut_reason"]


def test_given_lag_is_used_as_is(take, song_dir):
    video, _ = take
    a = run_cover("analyze", video, "--song-dir", song_dir, "--lag", "4.321")
    assert a["lag_cam"] == 4.321 and a["sync"]["note"] == "lag given by caller"


# ------------------------------------------------------------------ pieces

def _quiet_then_loud(sr=Y.SR):
    rnd = np.random.default_rng(0)
    x = 1e-3 * rnd.standard_normal(10 * sr)
    x[3 * sr: 8 * sr] += 0.5 * rnd.standard_normal(5 * sr)
    return x.astype(np.float32)


def test_playing_region():
    entry, stop, _ = Y.playing_region(_quiet_then_loud())
    assert entry == pytest.approx(3.0, abs=0.15) and stop == pytest.approx(8.0, abs=0.2)


def test_playing_region_of_silence_does_not_crash():
    entry, stop, _ = Y.playing_region(np.zeros(5 * Y.SR, np.float32))
    assert 0 <= entry <= stop <= 5.0 + 1e-6


def test_cut_falls_back_without_a_section_change():
    flat = np.full(30 * Y.SR, 0.1, np.float32) * np.sin(np.arange(30 * Y.SR) / 10)
    c = Y.find_cut(flat, stop_cam=10.0, lag=5.0)
    assert c["rise_db"] < 6 and c["stop_song"] == 15.0


def test_cut_near_end_of_song_has_no_boundary():
    x = np.ones(int(5 * Y.SR), np.float32)
    assert Y.find_cut(x, stop_cam=10.0, lag=5.0)["boundary_song"] is None


def test_song_shorter_than_playing_is_an_error():
    rnd = np.random.default_rng(1)
    cam = rnd.standard_normal(20 * Y.SR).astype(np.float32)
    short = rnd.standard_normal(3 * Y.SR).astype(np.float32)
    with pytest.raises(ValueError, match="shorter"):
        Y.find_lag(cam, short, short, entry=1.0, stop=19.0, ref=0.0)
