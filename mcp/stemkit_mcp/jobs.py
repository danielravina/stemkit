"""Background jobs, so long steps (download, stem split, render) never hit a tool timeout."""

from __future__ import annotations

import threading
import time
import traceback
import uuid
from typing import Any, Callable

_JOBS: dict[str, dict[str, Any]] = {}
_LOCK = threading.Lock()


def start(kind: str, fn: Callable[..., Any], **kwargs: Any) -> str:
    jid = f"{kind}-{uuid.uuid4().hex[:8]}"
    job = {"id": jid, "kind": kind, "status": "running", "stage": "starting",
           "log": [], "started": time.time(), "result": None, "error": None}
    with _LOCK:
        _JOBS[jid] = job

    def progress(msg: str) -> None:
        with _LOCK:
            job["stage"] = msg
            job["log"].append(f"{time.time() - job['started']:6.1f}s  {msg}")

    def target() -> None:
        try:
            res = fn(progress=progress, **kwargs)
            with _LOCK:
                job.update(status="done", stage="done", result=res)
        except Exception as e:  # report every failure to the caller
            with _LOCK:
                job.update(status="error", stage="failed", error=f"{type(e).__name__}: {e}",
                           trace=traceback.format_exc()[-2000:])

    threading.Thread(target=target, daemon=True).start()
    return jid


def status(jid: str) -> dict:
    with _LOCK:
        job = _JOBS.get(jid)
        if not job:
            return {"error": f"no job {jid} (jobs live only as long as the server process)"}
        out = {k: v for k, v in job.items() if k != "trace"}
        out["elapsed_s"] = round(time.time() - job["started"], 1)
        if job["status"] == "error":
            out["trace"] = job.get("trace")
        return out


def all_jobs() -> list[dict]:
    with _LOCK:
        return [{"id": j["id"], "kind": j["kind"], "status": j["status"], "stage": j["stage"]}
                for j in _JOBS.values()]
