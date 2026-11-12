"""Render contracts (coverkit/render.py + cover.py make).

Contract for make(video, song_dir, instrument, [--lag] [--cut] [--set k=v] [--out]):
  pre   the video exists and has audio; the split has a stem for the instrument; every
        --set key is known and has the default's type; --out is not the input.
        All of this is checked before the slow analysis.
  post  writes one mp4: the picture stream-copied, AAC 48 kHz audio, ending at the cut;
        the backing is the song minus the instrument, placed so song time = video time +
        offset (to the sample); true peak <= limiter + 1 dB; loudness over the playing near
        final_lufs; the input file untouched. The same checks are measured on the output
        and returned as `checks` / `checks_passed`.
"""

from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path

import numpy as np
import pytest

import cover_synth as S
from conftest import needs_ffmpeg, run_cover
from coverkit import render as R
from coverkit.media import load_mono, probe

pytestmark = needs_ffmpeg


def sha(p) -> str:
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


# ------------------------------------------------------------------ end to end

@pytest.fixture(scope="module")
def made(request):
    return {}


def make(take, song_dir, made, tmp_path_factory) -> tuple[dict, str]:
    video, a0 = take
    if a0 not in made:
        before = sha(video)
        out = tmp_path_factory.mktemp("out") / "cover.mp4"
        r = run_cover("make", video, "--song-dir", song_dir, "--instrument", "drums", "--out", out)
        made[a0] = (r, before)
    return made[a0]


def test_make_passes_its_own_checks(take, song_dir, made, tmp_path_factory):
    r, _ = make(take, song_dir, made, tmp_path_factory)
    assert r["checks_passed"], r["checks"]
    assert set(r["checks"]) == {"video_copied", "has_audio", "duration", "true_peak", "loudness",
                                "input_untouched"}


def test_output_streams_and_length(take, song_dir, made, tmp_path_factory):
    video, a0 = take
    r, _ = make(take, song_dir, made, tmp_path_factory)
    o, src = probe(r["output"]), probe(video)
    assert o["video_codec"] == src["video_codec"] and o["has_audio"] and o["audio_rate"] == 48000
    assert abs(o["duration"] - r["cut"]["video_seconds"]) <= 0.15
    assert r["mix"]["true_peak_dbtp"] <= -0.5
    assert set(r["mix"]["backing_stems"]) == {"vocals", "bass", "other"}
    assert r["mix"]["ducked"] == ["bass"]


def test_input_untouched(take, song_dir, made, tmp_path_factory):
    video, _ = take
    _, before = make(take, song_dir, made, tmp_path_factory)
    assert sha(video) == before


def _offset_ms(a: np.ndarray, b: np.ndarray, sr: int, window: float = 0.2) -> float:
    """How much later b's content appears in a, in ms (cross-correlation peak)."""
    n = min(len(a), len(b))
    a, b = a[:n] - a[:n].mean(), b[:n] - b[:n].mean()
    m = 1 << int(np.ceil(np.log2(2 * n)))
    c = np.fft.irfft(np.fft.rfft(a, m) * np.conj(np.fft.rfft(b, m)), m)
    w = int(window * sr)
    return (int(np.argmax(np.concatenate([c[-w:], c[: w + 1]]))) - w) / sr * 1000


def test_backing_is_placed_to_the_sample(take, song_dir, made, tmp_path_factory):
    """The song's backing sits exactly where the reported offset says (song = video + offset),
    and that is within the sync tolerance of the truth."""
    video, a0 = take
    r, _ = make(take, song_dir, made, tmp_path_factory)
    sr = 11025
    out = load_mono(r["output"], sr, 6.0, 24.0)

    def backing_at(off):
        return sum(load_mono(song_dir / "stems" / f"{n}.wav", sr, 6.0 + off, 24.0)
                   for n in ("bass", "other", "vocals"))

    told = r["sync"]["song_offset_at_video_start"]
    assert abs(_offset_ms(out, backing_at(told), sr)) <= 1.0
    assert abs(_offset_ms(out, backing_at(S.LAG - a0), sr)) <= 6.0


def test_player_stays_on_the_picture(take, song_dir, made, tmp_path_factory, camera):
    """The player's own track is not shifted: camera time t plays at video time t + audio start."""
    video, a0 = take
    r, _ = make(take, song_dir, made, tmp_path_factory)
    sr = 11025
    out = load_mono(r["output"], sr, 4.0 + a0, 14.0)
    cam = camera[int(4.0 * S.CAM_SR): int(18.0 * S.CAM_SR)]
    cam = np.interp(np.arange(0, len(cam) / S.CAM_SR, 1 / sr), np.arange(len(cam)) / S.CAM_SR, cam)
    assert abs(_offset_ms(out, cam, sr)) <= 1.0


# ------------------------------------------------------------------ checked before the slow part

def test_bad_setting_fails_before_analysis(take, song_dir, tmp_path):
    video, _ = take
    for bad in ("fizz_db=loud", "duck=heavy", "nope=1", "kick_db", "deess=1"):
        r = run_cover("make", video, "--song-dir", song_dir, "--set", bad, check=False)
        assert r["returncode"] == 1 and "error" in r, bad
    assert not (tmp_path / "cache").exists()               # never got to extracting audio


def test_refuses_to_overwrite_the_input(take, song_dir, tmp_path):
    video, _ = take
    r = run_cover("make", video, "--song-dir", song_dir, "--out", video, check=False)
    assert r["returncode"] == 1 and "overwrite" in r["error"]
    assert not (tmp_path / "cache").exists()


def test_refuses_an_instrument_the_split_lacks(take, song_dir, tmp_path):
    video, _ = take
    r = run_cover("make", video, "--song-dir", song_dir, "--instrument", "guitar", check=False)
    assert r["returncode"] == 1 and "htdemucs_6s" in r["error"]
    assert not (tmp_path / "cache").exists()


def test_analyze_warns_about_a_missing_stem(take, song_dir):
    video, _ = take
    a = run_cover("analyze", video, "--song-dir", song_dir, "--instrument", "piano")
    assert a["warnings"] and "piano" in a["warnings"][0]


def test_missing_video_and_song_dir(tmp_path, song_dir):
    r = run_cover("make", tmp_path / "nope.mp4", "--song-dir", song_dir, check=False)
    assert r["returncode"] == 1 and "no such video" in r["error"]
    vid = S.make_video(tmp_path / "v.mp4", np.zeros(48000 * 2))
    r = run_cover("analyze", vid, "--song-dir", tmp_path / "empty", check=False)
    assert r["returncode"] == 1 and "no stem wavs" in r["error"]


def test_silent_recording_is_a_clear_error(tmp_path, song_dir):
    vid = S.make_video(tmp_path / "silent.mp4", np.zeros(48000 * 20))
    r = run_cover("make", vid, "--song-dir", song_dir, "--lag", "5", check=False)
    assert r["returncode"] == 1 and "loudness" in r["error"]


def test_video_without_audio(tmp_path, song_dir):
    v = tmp_path / "mute.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=64x48:duration=2",
                    "-c:v", "mpeg4", str(v)], check=True)
    r = run_cover("analyze", v, "--song-dir", song_dir, check=False)
    assert r["returncode"] == 1 and "no audio" in r["error"]


def test_settings_command():
    s = run_cover("settings", "--instrument", "bass")
    assert s["comp_ratio"] == 3.0 and s["inst_lufs"] == -16.5 and "kick_db" not in s


# ------------------------------------------------------------------ pieces

@pytest.mark.parametrize("overrides,msg", [
    ({"nope": 1}, "unknown setting"), ({"fizz_db": "x"}, "number"), ({"fizz_db": True}, "number"),
    ({"fizz_db": float("nan")}, "number"), ({"duck": "heavy"}, "duck"), ({"fade": -1}, "fade"),
    ({"limiter_db": 1}, "limiter_db"),
])
def test_settings_reject(overrides, msg):
    with pytest.raises(ValueError, match=msg):
        R.settings("drums", overrides)


def test_settings_accept_and_merge():
    s = R.settings("drums", {"fizz_db": -3, "duck": "off", "kick_layer": 1.8})
    assert s["fizz_db"] == -3 and s["duck"] == "off" and s["inst_lufs"] == -16.5
    assert R.settings("vocals", {"deess": False})["deess"] is False
    assert R.settings("kazoo", None)["comp_ratio"] == R.INSTRUMENT_DEFAULTS["other"]["comp_ratio"]


@pytest.mark.parametrize("instrument", list(R.INSTRUMENT_DEFAULTS))
@pytest.mark.parametrize("windows", [[], [(0.2, 1.2)]])
def test_every_instrument_chain_runs_in_ffmpeg(tmp_path, instrument, windows):
    src = S.write_wav(tmp_path / "in.wav",
                      0.1 * np.random.default_rng(0).standard_normal(48000 * 3), 48000)
    graph, kick = R.instrument_chain(instrument, R.settings(instrument, None), 3.0, windows)
    assert kick == (instrument == "drums")
    out = tmp_path / "out.wav"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-filter_complex", graph,
                    "-map", "[o]", "-c:a", "pcm_f32le", str(out)], check=True)
    x = load_mono(out, 48000)
    assert abs(len(x) / 48000 - 3.0) < 0.05 and np.isfinite(x).all() and np.abs(x).max() > 0


def test_align_song():
    assert R._align_song(1.5) == "atrim=start=1.5000,asetpts=PTS-STARTPTS"
    assert R._align_song(-0.25) == "adelay=250.0:all=1"


def test_noise_windows_come_from_before_the_entry(tmp_path):
    rnd = np.random.default_rng(0)
    x = 0.001 * rnd.standard_normal(48000 * 8)
    x[48000 * 5:] += 0.3 * rnd.standard_normal(48000 * 3)
    wav = S.write_wav(tmp_path / "cam.wav", x, 48000)
    w = R.noise_windows(wav, 5.0)
    assert 1 <= len(w) <= 2 and all(0 <= a < b <= 5.0 and b - a == pytest.approx(1.0) for a, b in w)
    assert R.noise_windows(wav, 1.0) == []


def test_filter_latency_is_measured():
    assert R.filter_latency("anull") == 0
    assert R.filter_latency("adelay=10:all=1") == pytest.approx(0.010, abs=1 / 48000)


def test_limiter_is_compensated(tmp_path):
    x = np.zeros(48000, np.float32)
    x[24000] = 0.9
    src = S.write_wav(tmp_path / "imp.wav", x, 48000)
    p = subprocess.run(["ffmpeg", "-v", "error", "-i", str(src), "-af", R._limiter(0.5),
                        "-f", "f32le", "-ac", "1", "-"], capture_output=True, check=True)
    y = np.frombuffer(p.stdout, np.float32)
    assert abs(int(np.argmax(np.abs(y))) - 24000) <= 2
