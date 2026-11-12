---
name: make-cover
description: Turn a video of someone playing along to a song (drums, bass, guitar, piano, vocals) into a full-band cover video. Finds the song on YouTube, splits it with StemKit, drops the stem for the instrument they played, syncs their recording to the bar, cleans it up, mixes it over the backing and writes a new video. Use when the user has a play-along or cover recording and wants the band added, the song synced under it, or "my take on top of the stems".
---

# Make a cover video

Needs the **stemkit MCP server** (`search_youtube`, `split_song`, `job_status`, `get_song`,
`export_audio`), `ffmpeg`, and `uv`. The audio work runs in `scripts/cover.py`, and this
skill orchestrates it.

`SKILL_DIR` is the folder this file is in. Run the script as:

```bash
uv run --quiet --with numpy python "$SKILL_DIR/scripts/cover.py" <command> ...
```

## 1. Gather the inputs

- **Video**: path to the recording. Its audio should be mostly the person's own
  instrument. With headphones on, it usually is.
- **Instrument**: drums, bass, guitar, piano, vocals or other. Ask if it's unclear.
- **Song**: use it if they named it or gave a URL. Otherwise guess from the file name
  (`victorylap5.mp4` → "victory lap five") and confirm with them before splitting.

## 2. Find the original recording

Call `search_youtube("<artist> <title>")` and pick the **original studio version**:

- Prefer the artist's own channel, "Official Audio", or "<Artist> - Topic".
- Skip covers, live, remixes, sped up / slowed, nightcore, karaoke, instrumentals,
  "improvisation", extended edits, studio sessions and lyric re-uploads of other songs.
- The duration has to be at least as long as the playing in the video.

If two plausible originals disagree (different edits or lengths), ask the user.

## 3. Split it

Call `split_song(url, model=...)`. Use `htdemucs_6s` for guitar or piano, and the default
otherwise. Poll `job_status(job_id, wait_seconds=55)` until it's done (about 3 minutes on CPU;
a song already in the library returns at once). Then call `get_song(video_id)`. The song
folder is the parent directory of its `mix` path.

## 4. Make the video

```bash
uv run --quiet --with numpy python "$SKILL_DIR/scripts/cover.py" make "<video>" \
  --song-dir "<song folder>" --instrument drums
```

This writes `<video>_with_stems.mp4` (drums) or `<video>_with_band.mp4` next to the input,
and never overwrites the input. Progress goes to stderr and a JSON report to stdout.

What it does:

- **Sync.** It matches the playing against the same instrument's stem in three ways:
  onsets for sub-beat timing, where the player plays and rests (so it lands on the right
  bar), and the player's entry against a section start in the song. Then it refines to
  the millisecond.
- **Cut.** It ends where the next song section starts after the player stops, with a
  0.2 s fade, so the new section never bleeds in.
- **Clean-up.**
  - Every instrument: noise learned from the quiet stretch before the player starts,
    plus clipping repair.
  - Drums: kick body at 60 Hz, a light cut on mic-overload fizz at 3.8 kHz, and a gated
    kick layer.
  - Bass, vocals and guitar/keys: their own EQ and compression.
- **Mix.** Player at -16.5 LUFS, backing at -16, final mix around -13 LUFS with peaks at
  or below -1.5 dBFS. For drums, the song's bass dips 2–3 dB under each kick.
- **Video.** The picture is stream-copied and the camera's audio start offset is
  accounted for.

## 5. Report

Tell the user:

- the output path
- where they come in, as video time and song time
- the sync confidence
- the cut point and why it was chosen
- the final loudness

If confidence is below 1.5, list `bar_alternatives` so they can pick one by ear.

## 6. Fix it by ear

The user will listen. Map what they say to a re-run of `make`, which takes about a
minute because the extracted camera audio is cached:

| they say | do |
|---|---|
| "comes in early/late", "off by a bar" | `--lag <a bar_alternatives lag>`, or add/subtract `4*60/bpm` |
| "a little ahead/behind" | `--lag` ± 0.01–0.03 |
| "cut too early/late", "new section bleeds in" | `--cut <video seconds>` |
| "my part too loud/quiet" | `--set inst_lufs=-15` (louder) / `-18` (quieter) |
| "harsh", "snare tearing" | `--set fizz_db=-3` (more cut), max about -5 |
| "can't hear what I'm playing", "muffled" | `--set fizz_db=-1 --set duck=off --set inst_lufs=-16` |
| "kick buried" | `--set kick_db=7 --set kick_layer=1.8` or `--set duck=medium` |
| "too boomy" | `--set kick_db=4 --set kick_layer=1.0` |
| "noisy" | `--set denoise_nr=18` |

`cover.py settings --instrument <x>` lists every setting. Lessons from tuning on a real
drum take: **clarity beats polish**. Heavy fizz cuts (-5 dB) and strong ducking (4–6 dB)
made the fills hard to follow, and the player wanted to hear their improvisation. Start
light.

`cover.py analyze` gives sync and cut alone, without rendering. It's useful to check a
take before committing.

## Extras via the MCP

- A practice track without their instrument: `export_audio(video_id, mode="mixed",
  stems=[all but theirs])`. Leaving out vocals gives the file "instrumental" naming.
- Transposed backing: pass `semitones` to `export_audio`.
- Their own key: `get_song(...).key_effective`.
