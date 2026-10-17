# Signalsmith Stretch Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task.

**Goal:** Replace SoundTouchJS practice playback with Signalsmith Stretch, preserving one tempo control, original pitch, synchronized clicks, mixing, and original-speed exports.

**Spec:** User explicitly requested: plan first, then proceed with Signalsmith. No extra approval checkpoint.

**Architecture:** Reuse the engine's shared post-mix pitch-processing seam. Keep source-time coordinates and native source playback rates; use Signalsmith's live-input pitch shift to compensate that rate, with its reported/measured latency keeping metronome timing aligned. Adapt asynchronous processor construction only as required by the official API. Normal speed bypasses processing.

**Tech Stack:** Existing Electron/React/TypeScript/Web Audio/Vite; official signalsmith-stretch WASM/AudioWorklet package. No backend or schema change.

## Constraints

- Preserve all existing uncommitted work and settings; work in the existing workspace. No commits, branch creation, or PR publication requested yet.
- Keep tempo detection, stem separation, count-in controls, font styling, export behavior and resource optimizations unchanged.
- Do not keep multiple selectable processors or add quality/pitch settings. Retain SoundTouch only during comparison; remove unused packages/code after Signalsmith passes.
- Preserve cancellation during startup, rate changes, seeks, pause, song replacement and failures. No stale sound or processor leaks.
- Measure quality-related signal behavior and CPU; do not claim subjective listening superiority without a listening comparison.

## Review Focus

- Processor/WASM loading must work in dev and production file URLs under the existing CSP; avoid broad CSP relaxation.
- Fresh processors must not replay stale audio after seeking; asynchronous setup must respect cancellations.
- Shared processing must preserve relative stem alignment, stereo pan and live volume/mute/solo.
- Clicks, count-in, source clock and tails must align at44.1/48kHz and slower/faster speeds.
- Measure representative0.75/0.9 speed CPU and produce same-source audio comparison artifacts.

## Task 1: Baseline and integration

Files: practice-audio.ts, engine.ts if required by async construction, package.json/lockfile, practice-audio.electron.cjs and engine.test.mjs.

- [x] Save baseline processor code and rendered comparisons/metrics outside the working source tree.
- [x] Inspect the pinned official Signalsmith API, lifecycle, loading and licensing. Install exact version and choose the narrowest compatible integration.
- [x] Add failing lifecycle regressions for any changed asynchronous engine contract and processor loading.
- [x] Implement Signalsmith in the existing shared mix path with correct rate/pitch compensation, latency and disposal.
- [x] Run rendered pitch, beat alignment, count-in, pan, tails and production file/CSP checks. Compare0.75/0.9 CPU with baseline and save listening clips.

## Task 2: Cleanup and proof

Files: unused practice-processor.ts, package.json/lockfile, README.md, tests/count-in.electron.cjs as required.

- [x] Remove unused SoundTouch packages/processor once replacement passes.
- [x] Update docs and retain concise comparison measurements/limitations in this plan.
- [x] Run typecheck, build, default tests, audio tests, practice render tests and desktop interactions.
- [ ] Independent review was attempted but the reviewer hit the account usage limit. Author reviewed the migration and cancellation paths; automated acceptance checks pass.


## Implementation evidence

- Pinned official `signalsmith-stretch@1.3.2` (MIT); removed all four SoundTouch packages and the old processor.
- Kept the shared post-mix path and native source playback rates. Live-input pitch compensation uses `-12 * log2(rate)`; the worklet reports its latency. Original-speed playback bypasses DSP.
- Bundled the official worklet as a static Vite asset with embedded WASM. CSP adds only `wasm-unsafe-eval`; packaged file-URL loading passes.
- Added cancellation regressions for asynchronous processor creation during pause and seek, plus startup failure. Source position holds while a processor initializes; stale processors are disposed.
- Twelve actual audio renders cover 0.5, 0.75, 0.9, 1, 1.5 and 2× at 44.1/48 kHz. Pitch, click alignment, count-in, stereo pan and tails pass. Maximum measured synthetic beat offset was under 2 ms.
- Improved the pitch test's measurement to interpolate zero crossings and measure complete periods. The old integer count quantized a short 2× window in approximately 13 Hz steps.
- Desktop count-in timing now checks audible onset using the actual processor latency, with a tighter 25 ms tolerance.
- Verification: typecheck, build, 45 audio/storage/import/export tests, 4 default tests, rendered audio/file-CSP tests, and the complete Electron count-in/player interactions passed.

## Comparison

Matched 12-second excerpts of So Far Away's full mix, vocals and drums at 0.75 and 0.9× were rendered through both production adapters. Six-render cumulative renderer CPU fell from 3.989 to 1.909 seconds (about 52%). Offline render wall times fell from 504–550 ms per excerpt to 195–239 ms. This is an offline benchmark, not a guarantee of live playback CPU on every device.

Baseline/new WAVs and metrics are local artifacts in `/tmp/stemkit-stretch-comparison/`. Listening quality still requires a human comparison; no subjective improvement is claimed. Tempo detection, imports and exports retain their prior behavior.
