#!/usr/bin/env python3
"""Play-along recording + StemKit stems -> synced, cleaned, mixed cover video.

    cover.py analyze VIDEO --song-dir DIR [--instrument drums] [--lag S]
    cover.py make    VIDEO --song-dir DIR [--instrument drums] [--lag S] [--cut S]
                     [--out FILE] [--set key=value ...]
    cover.py settings [--instrument drums]

DIR is a StemKit song folder (mix.wav + stems/*.wav): the parent of `mix` from the
stemkit MCP's get_song. Prints JSON on stdout, progress on stderr.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from coverkit import render as R  # noqa: E402
from coverkit import sync as Y  # noqa: E402
from coverkit.media import MediaError, extract_audio, probe, require_ffmpeg  # noqa: E402

INSTRUMENTS = ("drums", "bass", "guitar", "piano", "vocals", "other")


def log(msg: str) -> None:
    print(f"... {msg}", file=sys.stderr, flush=True)


def song_files(song_dir: str) -> tuple[dict[str, str], str | None]:
    d = Path(song_dir).expanduser()
    stems = {p.stem: str(p) for p in (d / "stems").glob("*.wav")}
    if not stems:
        stems = {p.stem: str(p) for p in d.glob("*.wav") if p.stem != "mix"}
    if not stems:
        raise MediaError(f"no stem wavs in {d} (expected stems/<name>.wav)")
    mix = d / "mix.wav"
    return stems, str(mix) if mix.exists() else None


def work_dir(video: str) -> Path:
    p = Path(video).resolve()
    st = p.stat()
    h = hashlib.sha1(f"{p}|{st.st_size}|{st.st_mtime}".encode()).hexdigest()[:12]
    base = Path(os.environ.get("STEMKIT_COVER_CACHE", Path.home() / ".cache" / "stemkit-cover"))
    d = base / h
    d.mkdir(parents=True, exist_ok=True)
    return d


def analyze(video: str, song_dir: str, instrument: str, lag: float | None) -> tuple[dict, dict, Path]:
    require_ffmpeg()
    info = probe(video)
    if not info["has_audio"]:
        raise MediaError("the video has no audio track to take the playing from")
    stems, mix = song_files(song_dir)
    warnings = []
    if instrument not in stems:
        warnings.append(f"no {instrument} stem in this split: synced against the full mix, and "
                        "`make` will refuse (the original part would stay in the backing)")
        log(warnings[-1])
    work = work_dir(video)
    cam = work / "camera.wav"
    if not cam.exists():
        log("extracting the recording from the video")
        extract_audio(video, cam)
    log("lining the playing up with the song")
    a = Y.analyze(str(cam), info["audio_start"], info["duration"], stems, instrument, mix, lag=lag)
    a["video"] = str(Path(video).resolve())
    a["song_dir"] = str(Path(song_dir).expanduser().resolve())
    a["warnings"] = warnings
    (work / f"analysis_{instrument}.json").write_text(json.dumps(a, indent=2))
    return a, stems, work


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="cover.py")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("analyze", "make"):
        p = sub.add_parser(name)
        p.add_argument("video")
        p.add_argument("--song-dir", required=True)
        p.add_argument("--instrument", default="drums", choices=INSTRUMENTS)
        p.add_argument("--lag", type=float, help="song time = camera audio time + lag (s)")
        if name == "make":
            p.add_argument("--cut", type=float, help="end the video here (video seconds)")
            p.add_argument("--out")
            p.add_argument("--set", action="append", default=[], metavar="KEY=VALUE")
    sp = sub.add_parser("settings")
    sp.add_argument("--instrument", default="drums", choices=INSTRUMENTS)
    a = ap.parse_args(argv)

    if a.cmd == "settings":
        print(json.dumps(R.settings(a.instrument, None), indent=2))
        return 0
    video = str(Path(a.video).expanduser().resolve())
    if not Path(video).is_file():
        raise MediaError(f"no such video: {video}")
    sets = {}
    if a.cmd == "make":
        # check everything cheap before the slow analysis
        for kv in a.set:
            if "=" not in kv:
                raise ValueError(f"--set wants KEY=VALUE, got {kv!r}")
            k, v = kv.split("=", 1)
            try:
                sets[k] = json.loads(v)
            except json.JSONDecodeError:
                sets[k] = v
        R.settings(a.instrument, sets)
        suffix = "with_stems" if a.instrument == "drums" else "with_band"
        out = a.out or str(Path(video).with_name(f"{Path(video).stem}_{suffix}.mp4"))
        if Path(out).expanduser().resolve() == Path(video):
            raise MediaError("output would overwrite the input video")
        if a.cut is not None and a.cut <= 0:
            raise ValueError("--cut must be a positive time in video seconds")
        if a.instrument not in song_files(a.song_dir)[0]:
            raise MediaError(f"this split has no '{a.instrument}' stem; re-split with htdemucs_6s "
                             "for guitar or piano, or use --instrument other")
    an, stems, work = analyze(video, a.song_dir, a.instrument, a.lag)
    if a.cmd == "analyze":
        print(json.dumps(an, indent=2))
        return 0

    if a.cut is not None:
        an["cut_video"], an["cut_reason"] = float(a.cut), "cut given by caller"
    res = R.render(video, stems, a.instrument, an, out, work, sets, log)
    print(json.dumps({
        "output": res["output"],
        "sync": {"lag_seconds": an["lag_cam"], "confidence": an["sync"].get("confidence"),
                 "song_offset_at_video_start": an["song_offset_at_video_start"],
                 "bpm": an["sync"].get("bpm"), "enters_at_video": an["entry_video"],
                 "enters_at_song": an["entry_song"],
                 "bar_alternatives": [{k: c[k] for k in ("lag", "bars_from_best", "score")}
                                      for c in an["sync"].get("bar_alternatives", [])]},
        "cut": {"video_seconds": an["cut_video"], "reason": an["cut_reason"]},
        "mix": {k: res[k] for k in ("duration", "loudness_lufs", "true_peak_dbtp", "gains_db",
                                    "backing_stems", "ducked", "noise_profile_windows")},
        "settings": res["settings"],
        "checks": res["checks"],
        "checks_passed": res["checks_passed"],
    }, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (MediaError, ValueError) as e:
        print(json.dumps({"error": str(e)}), flush=True)
        raise SystemExit(1)
