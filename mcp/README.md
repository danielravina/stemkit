# StemKit MCP server

StemKit without the window: lets Claude (or any MCP client) split songs, manage the
library and export stems.

It runs on the app's own data folder and engine. Songs split here show up in StemKit and
vice versa, and pan, pitch and key edits are shared with the player.

## Tools

| tool | app equivalent |
|---|---|
| `search_youtube` | search box |
| `split_song` | paste a link / drop a file (YouTube URL or id, or a local audio file; `roformer_hybrid` or `htdemucs_6s`; optional stem subset). Runs as a job |
| `job_status`, `cancel_split` | progress bar / cancel |
| `list_songs`, `get_song` | library sidebar (`get_song` also returns absolute stem/mix paths) |
| `delete_song` | delete |
| `detect_key`, `set_key` | key chip / override |
| `set_pitch`, `set_pan` | pitch control / pan knobs |
| `export_audio` | Export dialog: `mixed` (chosen stems in one file, "instrumental" naming), `separate` (one file per stem), `original`; with volumes, pan and pitch; WAV or AAC |
| `get_settings`, `set_settings` | Settings (engine, shifts, GPU, export format, auto-export folder) |
| `status` | setup screen |

Exports follow the app: 44.1 kHz 32-bit float WAV (or 256k AAC), the same
gain → pan → pitch chain, scaled down only when the mix would clip, and the same file
names. Pitch shifting uses ffmpeg's `rubberband` filter when available.

## Setup

1. Install StemKit and open it once so it sets up its engine.
2. Have `ffmpeg` on PATH and [uv](https://docs.astral.sh/uv/) installed.
3. Register the server. For Claude Code:

```bash
claude mcp add --scope user stemkit -- uv run --quiet --project /path/to/stemkit/mcp stemkit-mcp
```

| env var | default |
|---|---|
| `STEMKIT_DATA_DIR` | the app's data folder (same variable the app honours) |
| `STEMKIT_SCRIPTS` | `../python` in this repo, else the installed app's `resources/python` |
| `STEMKIT_FFMPEG` | `ffmpeg` on PATH |
