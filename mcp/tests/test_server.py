"""The MCP surface: tool names, schemas, and calls through the real tool layer."""

from __future__ import annotations

import asyncio
import json

import pytest
from mcp.server.mcpserver.exceptions import ToolError

from stemkit_mcp import engine as E
from stemkit_mcp import jobs
from stemkit_mcp import server as S

from .conftest import needs_ffmpeg

TOOLS = {"status", "search_youtube", "split_song", "job_status", "cancel_split", "list_songs",
         "get_song", "delete_song", "detect_key", "set_key", "set_pitch", "set_pan",
         "export_audio", "get_settings", "set_settings"}


def tools() -> dict:
    return {t.name: t for t in asyncio.run(S.mcp.list_tools())}


class ClientError(Exception):
    """What an MCP client is shown for a failed call."""


def call(name: str, **args):
    """Call through MCPServer (argument validation included); returns the tool's value.
    A failure raises ClientError with exactly the text the stdio handler would send
    (MCPServer._handle_call_tool returns str(exc) of the ToolError)."""
    try:
        res = asyncio.run(S.mcp.call_tool(name, args))
    except ToolError as e:
        raise ClientError(str(e)) from e
    if getattr(res, "is_error", False) or getattr(res, "isError", False):
        raise ClientError(res.content[0].text)
    sc = getattr(res, "structured_content", None) or getattr(res, "structuredContent", None)
    if sc is not None:
        return sc.get("result", sc) if set(sc) == {"result"} else sc
    return json.loads(res.content[0].text)


def test_tool_set_is_the_documented_one():
    assert set(tools()) == TOOLS


def test_every_tool_is_documented():
    for name, t in tools().items():
        assert t.description and len(t.description) > 20, name


def test_export_schema():
    props = tools()["export_audio"].input_schema["properties"]
    assert {"video_id", "mode", "stems", "volumes", "pans", "semitones", "format", "dest",
            "overwrite"} <= set(props)
    assert tools()["export_audio"].input_schema["required"] == ["video_id"]


def test_status_reports_missing_engine(data_dir):
    st = call("status")
    assert st["data_dir"] == str(data_dir)
    assert st["engine_ready"] is False and st["songs"] == 0


def test_settings_round_trip(data_dir):
    assert call("set_settings", patch={"shifts": 2, "bogus": 1})["shifts"] == 2
    assert call("get_settings")["shifts"] == 2


@needs_ffmpeg
def test_library_tools(make_song, tmp_path):
    make_song("abcdefghijk")
    assert [s["videoId"] for s in call("list_songs")] == ["abcdefghijk"]
    assert call("set_pitch", video_id="abcdefghijk", semitones=9) == {"semitones": 6}
    assert call("set_pan", video_id="abcdefghijk", pans={"drums": -2}) == {"pan": {"drums": -1.0}}
    assert call("set_key", video_id="abcdefghijk", key="Am")["key"]["override"] == "Am"
    song = call("get_song", video_id="abcdefghijk")
    assert song["pitch"] == 6 and song["pan"] == {"drums": -1.0} and song["key_effective"] == "Am"
    r = call("export_audio", video_id="abcdefghijk", stems=["drums"], dest=str(tmp_path / "o"))
    assert r["path"].endswith("Test Song - drums (+6).wav")
    assert call("delete_song", video_id="abcdefghijk") == {"deleted": "abcdefghijk"}
    assert call("list_songs") == []


def test_errors_reach_the_client(data_dir):
    with pytest.raises(ClientError, match="Unknown song"):
        call("get_song", video_id="nope")
    with pytest.raises(ClientError, match="semitones"):
        call("set_pitch", video_id="x")                  # missing argument


@needs_ffmpeg
def test_split_job_flow_and_delete_guard(fake_engine, song_file, monkeypatch):
    from stemkit_mcp import library as L
    monkeypatch.setenv("FAKE_SLEEP", "30")
    st = call("split_song", source=str(song_file))
    assert st["status"] == "running" and st["id"].startswith("split-")
    vid = E.local_song_id(str(song_file))
    done = call("job_status", job_id=st["id"], wait_seconds=0)
    for _ in range(200):
        if "separating" in (done.get("stage") or ""):
            break
        asyncio.run(asyncio.sleep(0.05))
        done = call("job_status", job_id=st["id"], wait_seconds=0)
    L.upsert_song({"videoId": vid})          # delete_song looks the song up before the busy check
    with pytest.raises(ClientError, match="being split"):
        call("delete_song", video_id=vid)
    assert call("cancel_split", video_id=vid) == {"cancelled": [vid]}
    done = call("job_status", job_id=st["id"], wait_seconds=10)
    assert done["status"] == "error" and "Cancelled" in done["error"]


@needs_ffmpeg
def test_split_job_completes(fake_engine, song_file):
    st = call("split_song", source=str(song_file), wait_seconds=20)
    assert st["status"] == "done"
    assert st["result"]["stems"] == ["vocals", "drums", "bass", "other"]


def test_wait_returns_as_soon_as_the_job_ends():
    import time
    jid = jobs.start("t", lambda progress: time.sleep(0.2) or 1)
    t0 = time.time()
    assert S._wait(jid, 999)["status"] == "done"
    assert time.time() - t0 < 5
    jid = jobs.start("t", lambda progress: time.sleep(3) or 1)
    assert S._wait(jid, 0)["status"] == "running"
