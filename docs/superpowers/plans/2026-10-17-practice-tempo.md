# Practice Tempo Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** One BPM control changes all song audio and metronome speed together while preserving musical pitch.

**Architecture:** Retain original decoded buffers and detected beat positions as source-time coordinates. Derive a playback ratio from requested BPM versus detected reference BPM, process the shared stem mix through a pitch-preserving library, and keep transport, seeks, clicks, and video on that source-time clock. Reset restores rate 1; downloads remain at original speed.

**Tech Stack:** Existing React/TypeScript/Web Audio/Electron; evaluate SoundTouchJS AudioWorklet using real audio renders before choosing routing and latency compensation.

**Spec:** Approved conversation: one whole-number BPM control initialized from detection, practice speed with preserved pitch, synchronized metronome, restore icon, original-speed downloads.

## Global Constraints

- Preserve all existing uncommitted work. No commits or publishing requested.
- Preserve volume, pan, mute/solo, count-in, cancellation and per-song tempo persistence.
- Keep timeline in original song seconds; keep genuine tempo changes using a fixed speed ratio.
- With no reliable detection, retain manual clicks at original speed; do not infer a speed ratio.
- No additional speed controls, pitch controls, loop feature, or stretched exports.

## Review Focus

- Late detection, missing detection, and restored saved settings must never silently start or resume playback.
- Pausing, seeking or switching songs during asynchronous processor setup must cancel stale work.
- Live tempo changes must preserve source position and apply one ratio to every stem and click.
- Count-in must use target BPM and lead into synchronized audio without a duplicate count.
- Pitch processing latency, pitch retention, stem alignment and short audio tails require rendered-audio checks.

### Task 1: Pitch-preserving engine playback

Files: src/renderer/src/lib/engine.ts, new pitch-processing adapter, package.json/lockfile, tests/engine.test.mjs, Electron audio-render tests.

- [x] Add tests for a 0.75 and 1.5 speed ratio, source clock, pause/seek/reset, canceled setup and pitch retention.
- [x] Evaluate library routing with real sine and pulse renders; use a shared processor to preserve stem phase and compensate measured processing latency.
- [x] Implement async engine rate changes with source-position continuity, normal-speed bypass, cleanup and errors.
- [x] Verify engine regressions and rendered audio duration/frequency/beat alignment.

### Task 2: Connect the single tempo control

Files: Player.tsx, CountInControls.tsx, youtube.ts, tempo-client.ts if needed, tests/count-in.electron.cjs, README.md.

- [x] Add interaction coverage for live BPM changing song speed, matching metronome timing, reset, saved ratio, no detection fallback and count-in.
- [x] Use original detected beat positions even with a practice BPM. Base the ratio on a stable detected reference, not a moving local tempo estimate.
- [x] Apply rate before start and on live edits; video follows supported rates with existing seek synchronization fallback. Keep exports at original speed including detected metronome timing when available.
- [x] Update docs; run typecheck, audio tests and desktop integration tests. Stop when acceptance passes.

## Implementation decisions and verification

- Use one shared SoundTouchJS processor after stem gains/pans to keep stems aligned. Original-speed audio bypasses processing.
- Configure the library's short WSOLA windows synchronously in a thin processor wrapper; default windows dropped brief attacks at faster ratios in rendered tests.
- Measure startup delay per sample rate/ratio; schedule clicks and source clock on audible output. Keep a silent input until disposal to drain audio tails.
- Persist optional sourceBpm captured at the edited section, keeping a fixed speed ratio across seeks and natural tempo changes. Older settings retain their first-section baseline.
- Derived count-in may be 3–3000 BPM; user edits remain whole numbers 30–300. Processor rate range .1–10 covers that full input range.
- Continue in the existing workspace with its prior uncommitted work; preserve changes and do not commit or publish.
- Engine/storage/tempo/export suite: 42 passing tests. Default suite: 4 passing tests.
- Rendered audio: 10 cases across .5/.75/1/1.5/2× and 44.1/48 kHz, including count-in, pitch, beat alignment, pan separation and tails. Production file URL/CSP loading passes.
- Independent review found reference-tempo, derived count range, max-rate and failed-analysis cases; fixes have focused regression coverage. Desktop checks pass, including legacy settings, later-section edits, pause/seek/count-in, original-speed exports, and manual fallback after detector failure.
