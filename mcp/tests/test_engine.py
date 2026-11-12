"""split_song / cancel_split contracts, run against the fake engine (no models, no network).

Contract for split(source, model, stems):
  pre   source is a YouTube URL / 11-char id or an existing audio file; model and stems
        are known names.
  post  on success: library entry with model tag, produced stems, detected key; every listed
        stem file is on disk; returns describe(song).
        an existing split made with the same engine that covers the request is reused and the
        engine is not run.
        on failure or cancel: the library entry and files are exactly what they were before.
"""

from __future__ import annotations

import os
import threading
import time

import pytest

from stemkit_mcp import engine as E
from stemkit_mcp import jobs
from stemkit_mcp import library as L
from stemkit_mcp.paths import StemKitError

from .conftest import needs_ffmpeg, probe

pytestmark = needs_ffmpeg


def snapshot(vid: str) -> dict:
    d = L.song_dir(vid)
    files = {str(p.relative_to(d)): p.read_bytes() for p in d.rglob("*") if p.is_file()} \
        if d.exists() else {}
    return {"songs": L.load_songs(), "files": files}


# ------------------------------------------------------------------ ids

@pytest.mark.parametrize("given,want", [
    ("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"),
    ("https://www.youtube.com/watch?list=x&v=dQw4w9WgXcQ&t=3", "dQw4w9WgXcQ"),
    ("https://youtu.be/dQw4w9WgXcQ?si=abc", "dQw4w9WgXcQ"),
    ("https://youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
    ("https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
    ("  dQw4w9WgXcQ  ", "dQw4w9WgXcQ"),
    ("dQw4w9WgXc", None), ("not a url", None), ("https://example.com/x", None),
])
def test_parse_video_id(given, want):
    assert E.parse_video_id(given) == want


def test_local_song_id_known_values():
    # values computed with src/shared/local.ts localSongId (see test_parity for the live check)
    assert E.local_song_id("") == "local-811c9dc5"
    assert E.local_song_id("/a") == E.local_song_id("/a")
    assert E.local_song_id("/a") != E.local_song_id("/b")


# ------------------------------------------------------------------ happy path

def test_split_local_file(fake_engine, song_file):
    out = E.split(str(song_file))
    vid = E.local_song_id(str(song_file))
    assert out["videoId"] == vid and out["source"] == "local"
    assert out["title"] == "My Song" and out["duration"] == 1
    assert out["model"] == "htdemucs" and out["stems"] == ["vocals", "drums", "bass", "other"]
    assert out["key"] == {"detected": "Am"} and out["key_effective"] == "Am"
    assert out["url"] is None
    assert set(out["stem_files"]) == set(out["stems"])
    assert all(os.path.isabs(p) and os.path.exists(p) for p in out["stem_files"].values())
    st = probe(out["mix"])["streams"][0]
    assert (st["sample_rate"], st["channels"], st["codec_name"]) == ("44100", 2, "pcm_s16le")
    assert L.load_songs()[0]["videoId"] == vid
    sep = fake_engine.calls("separate.py")
    assert len(sep) == 1 and "--model" in sep[0]["argv"] and "htdemucs" in sep[0]["argv"]


def test_same_engine_is_reused_without_running_it(fake_engine, song_file):
    first = E.split(str(song_file))
    msgs = []
    again = E.split(str(song_file), progress=msgs.append)
    assert again == first
    assert len(fake_engine.calls("separate.py")) == 1
    assert any("reusing" in m for m in msgs)


def test_subset_then_more_stems_matches_app(fake_engine, song_file):
    """app reuseOrPrepare: same engine, new stems -> keep the folder, record what was produced."""
    E.split(str(song_file), stems=["drums"])
    vid = E.local_song_id(str(song_file))
    assert E.split(str(song_file), stems=["drums"])["stems"] == ["drums"]   # covered
    out = E.split(str(song_file), stems=["bass"])
    assert out["stems"] == ["bass"]
    assert (L.stems_dir(vid) / "drums.wav").exists()                         # not wiped


def test_symlinked_file_is_keyed_by_the_given_path(fake_engine, song_file, tmp_path):
    """The app hashes the path the file dialog returns; it does not resolve symlinks."""
    link = tmp_path / "link.wav"
    link.symlink_to(song_file)
    assert E.split(str(link))["videoId"] == E.local_song_id(str(link))


def test_6_stem_model(fake_engine, song_file):
    out = E.split(str(song_file), model="htdemucs_6s")
    assert out["model"] == "htdemucs_6s"
    assert set(out["stems"]) == {"vocals", "drums", "bass", "other", "guitar", "piano"}


def test_roformer_vocals_path(fake_engine, song_file):
    L.save_settings({"roformerVocals": True})
    out = E.split(str(song_file))
    assert out["model"] == "roformer_hybrid"
    rof, sep = fake_engine.calls("roformer.py"), fake_engine.calls("separate.py")
    assert len(rof) == 1 and len(sep) == 1
    assert sep[0]["argv"][sep[0]["argv"].index("--only") + 1] == "drums,bass,other"
    assert set(out["stem_files"]) == {"vocals", "drums", "bass", "other"}


def test_engine_tag_follows_settings(data_dir):
    L.save_settings({"htdemucsFt": True, "shifts": 2})
    assert E.resolve_engine("roformer_hybrid", None)["tag"] == "htdemucs_ft-ft@s2"
    assert E.resolve_engine("htdemucs_6s", None)["tag"] == "htdemucs_6s@s2"
    L.save_settings({"htdemucsFt": False, "shifts": 1, "roformerVocals": True})
    assert E.resolve_engine("roformer_hybrid", ["drums"])["engine"] == "htdemucs"
    assert E.resolve_engine("roformer_hybrid", ["vocals"])["engine"] == "roformer_hybrid"


def test_auto_export_folder(fake_engine, song_file, tmp_path):
    L.save_settings({"exportFolder": str(tmp_path / "auto")})
    E.split(str(song_file))
    got = sorted(p.name for p in (tmp_path / "auto" / "My Song").iterdir())
    assert got == ["My Song.wav", "bass.wav", "drums.wav", "other.wav", "vocals.wav"]


# ------------------------------------------------------------------ bad input

@pytest.mark.parametrize("source,msg", [
    ("not a url", "Could not parse"),
    ("~/definitely/not/here.mp3", "No such audio file"),
    ("/nope/song.flac", "No such audio file"),
    ("song.wav", "No such audio file"),
])
def test_bad_sources(fake_engine, source, msg):
    with pytest.raises(StemKitError, match=msg):
        E.split(source)


def test_bad_stems_and_model(fake_engine, song_file):
    with pytest.raises(StemKitError, match="unknown stems"):
        E.split(str(song_file), stems=["kazoo"])
    with pytest.raises(StemKitError, match="unknown model"):
        E.split(str(song_file), model="spleeter")
    assert fake_engine.calls() == []


def test_unsupported_extension(fake_engine, tmp_path):
    f = tmp_path / "notes.txt"
    f.write_text("hi")
    with pytest.raises(StemKitError, match="unsupported audio file type"):
        E.split(str(f))


def test_engine_missing(data_dir, song_file):
    with pytest.raises(StemKitError, match="engine is not installed"):
        E.split(str(song_file))


# ------------------------------------------------------------------ failure keeps what was there

def test_failed_first_split_leaves_nothing(fake_engine, song_file, monkeypatch):
    monkeypatch.setenv("FAKE_FAIL", "1")
    with pytest.raises(StemKitError, match="fake engine failure"):
        E.split(str(song_file))
    vid = E.local_song_id(str(song_file))
    assert L.load_songs() == [] and not L.song_dir(vid).exists()


def test_failed_resplit_keeps_previous_split(fake_engine, song_file, monkeypatch):
    E.split(str(song_file))
    vid = E.local_song_id(str(song_file))
    L.save_pan(vid, {"drums": 0.5})
    before = snapshot(vid)
    L.save_settings({"htdemucsFt": True})            # different engine -> would start over
    monkeypatch.setenv("FAKE_FAIL", "1")
    with pytest.raises(StemKitError):
        E.split(str(song_file))
    assert snapshot(vid) == before
    assert not list(L.song_dir(vid).parent.glob(".*previous"))


def test_failed_add_stems_keeps_existing_stems(fake_engine, song_file, monkeypatch):
    E.split(str(song_file), stems=["drums"])
    vid = E.local_song_id(str(song_file))
    before = snapshot(vid)
    monkeypatch.setenv("FAKE_FAIL", "1")
    with pytest.raises(StemKitError):
        E.split(str(song_file), stems=["bass"])
    after = snapshot(vid)
    assert after["songs"] == before["songs"]
    assert after["files"]["stems/drums.wav"] == before["files"]["stems/drums.wav"]


def test_resplit_killed_half_way_is_recovered(fake_engine, song_file):
    """Server killed mid re-split: old split aside as .<id>.previous, partial new folder."""
    E.split(str(song_file))
    vid = E.local_song_id(str(song_file))
    before = snapshot(vid)
    d = L.song_dir(vid)
    d.rename(d.with_name(f".{vid}.previous"))
    (d / "stems").mkdir(parents=True)
    (d / "stems" / "vocals.wav").write_bytes(b"partial")
    out = E.split(str(song_file))                      # same engine: the old split is reused
    assert snapshot(vid) == before and out["stems"] == before["songs"][0]["stems"]
    assert len(fake_engine.calls("separate.py")) == 1
    assert not d.with_name(f".{vid}.previous").exists()


def test_leftover_backup_after_a_finished_split_is_dropped(fake_engine, song_file):
    E.split(str(song_file))
    vid = E.local_song_id(str(song_file))
    before = snapshot(vid)
    stale = L.song_dir(vid).with_name(f".{vid}.previous")
    stale.mkdir()
    (stale / "old.wav").write_bytes(b"x")
    E.split(str(song_file))
    assert snapshot(vid) == before and not stale.exists()


def test_successful_resplit_replaces_and_cleans_up(fake_engine, song_file):
    E.split(str(song_file))
    vid = E.local_song_id(str(song_file))
    L.save_settings({"htdemucsFt": True})
    out = E.split(str(song_file))
    assert out["model"] == "htdemucs_ft-ft"
    assert len(L.load_songs()) == 1
    assert not list(L.song_dir(vid).parent.glob(".*previous"))


# ------------------------------------------------------------------ jobs, cancel, busy

def _wait_stage(jid: str, needle: str, timeout: float = 10) -> None:
    end = time.time() + timeout
    while time.time() < end:
        if needle in (jobs.status(jid).get("stage") or ""):
            return
        time.sleep(0.05)
    raise AssertionError(f"job never reached '{needle}': {jobs.status(jid)}")


def _wait_done(jid: str, timeout: float = 10) -> dict:
    end = time.time() + timeout
    while time.time() < end:
        st = jobs.status(jid)
        if st["status"] != "running":
            return st
        time.sleep(0.05)
    raise AssertionError(f"job still running: {jobs.status(jid)}")


def test_cancel_restores_previous_split(fake_engine, song_file, monkeypatch):
    E.split(str(song_file))
    vid = E.local_song_id(str(song_file))
    before = snapshot(vid)
    L.save_settings({"htdemucsFt": True})
    monkeypatch.setenv("FAKE_SLEEP", "30")
    jid = jobs.start("split", E.split, source=str(song_file))
    _wait_stage(jid, "separating")
    assert E.is_busy(vid)
    assert E.cancel(vid) == [vid]
    st = _wait_done(jid, timeout=5)
    assert st["status"] == "error" and "Cancelled" in st["error"]
    assert snapshot(vid) == before
    assert not E.is_busy(vid)


def test_cancel_with_nothing_running(fake_engine):
    assert E.cancel() == [] and E.cancel("abcdefghijk") == []


def test_second_split_of_same_song_is_refused_while_busy(fake_engine, song_file, monkeypatch):
    monkeypatch.setenv("FAKE_SLEEP", "30")
    jid = jobs.start("split", E.split, source=str(song_file))
    _wait_stage(jid, "separating")
    with pytest.raises(StemKitError, match="already being processed"):
        E.split(str(song_file))
    E.cancel()
    _wait_done(jid)


def test_job_reports_errors_with_trace():
    def boom(progress):
        progress("about to fail")
        raise ValueError("nope")
    st = _wait_done(jobs.start("t", boom))
    assert st["status"] == "error" and st["error"] == "ValueError: nope"
    assert "Traceback" in st["trace"] and any("about to fail" in x for x in st["log"])


def test_job_result_and_unknown_job():
    st = _wait_done(jobs.start("t", lambda progress: {"ok": 1}))
    assert st["status"] == "done" and st["result"] == {"ok": 1} and "trace" not in st
    assert "no job" in jobs.status("t-missing")["error"]


def test_jobs_are_thread_safe():
    ids = []
    ts = [threading.Thread(target=lambda: ids.append(jobs.start("t", lambda progress: 1)))
          for _ in range(30)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    assert len(set(ids)) == 30
    assert all(_wait_done(j)["status"] == "done" for j in ids)
