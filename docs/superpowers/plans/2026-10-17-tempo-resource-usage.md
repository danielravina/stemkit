# Tempo Resource Usage Implementation Plan

> **For agentic workers:** Use executing-plans to implement task by task.

**Goal:** Reduce detection peak memory below 1 GiB on the measured four-minute song and eliminate waveform animation while paused, preserving tempo/beat results and playback quality.

**Architecture:** Profile current Librosa analysis stages in a fresh Python process. Calculate the existing tempogram in bounded overlapping blocks with identical global padding, precision and tempo decisions. Waveforms draw on changes and resize, and request continuous frames only during playback.

**Spec:** Approved conversation plan: stage measurements, smaller overlapping analysis blocks, paused redraw optimization, before/after memory/time and tempo regressions. No stretching changes.

## Constraints

- Preserve all existing uncommitted work; continue in this workspace; no commits or publishing.
- Keep Librosa and whole-song pulse, sustained tempo changes, silent intro/outro phase, and stable clicks during fills.
- Retain exact cached output compatibility if results match; do not force expensive cache rebuilds without a behavioral change.
- Do not change practice audio processing, add dependencies, change audio sample rate or reduce timing resolution.

## Task 1: Bound analysis temporaries

Files: python/tempo.py, python/test_tempo.py, src/main/tempo.ts, tests/tempo-analysis.test.mjs.

- [x] Save baseline output for all three available Staind recordings; measure peak RSS and elapsed time by analysis stage.
- [x] Add failing tests comparing blocked tempograms to Librosa for even/odd windows, boundaries, silent/random onsets, and block-size invariance.
- [x] Implement bounded FFT batches with global linear-ramp padding; avoid redundant median copies if profiling requires it.
- [x] Run Python regressions with all real fixtures. Compare full tempo/beat JSON before and after; measure final peak RSS/time in a fresh process.

## Task 2: Stop idle waveform redraws

Files: StemLane.tsx, MetronomeLane.tsx, Player.tsx, tests/count-in.electron.cjs.

- [x] Instrument real canvas paints in Electron; establish paused paints and test no repeated idle paints, playback animation, paused seek and resize redraw.
- [x] Pass playback state to shared lanes. Draw once on relevant changes and resize; run/cancel animation only during playback. Retain seek/playhead/mix controls.
- [x] Run typecheck, unit suites and Electron integration; document before/after resource results and limits. Obtain focused independent review.

## Measurement decisions

- The initial bounded tempogram alone still peaked at1792MiB. Profiling identified onset FFT temporaries and redundant median copies as remaining costs.
- Batch mel/STFT frames with global constant padding and global dB conversion, retain float64 tempograms with global ramp padding, and compute disposable row-batched medians once per section.
- Initial batching used more aggregate CPU due to math-library threading. A fresh-process trial limiting math libraries to one thread reduced SoFarAway CPU seconds from12.66 to4.58, elapsed4.95 to4.55 seconds, and peak932 to826MiB, preserving exact output. Apply this only to the tempo-analysis subprocess; stem splitting and playback are unaffected.
- The paused resize/seek test initially clicked before native window restoration completed, producing11.9 seconds (formatted0:11). Wait for actual restored canvas width before clicking; no product seek change.

## Final verification

- So Far Away: baseline3056MiB peak /5.92s elapsed /9.58 CPU-seconds; optimized826MiB /4.55s /4.58 CPU-seconds.
- For You: baseline2643MiB /5.14s /8.50 CPU-seconds; optimized807MiB /4.42s /4.40 CPU-seconds.
- Raining Again: baseline2941MiB /6.02s /9.21 CPU-seconds; optimized900MiB /5.12s /5.11 CPU-seconds.
- Fresh analysis processes on this Mac with warm NumPy/Numba installation caches; disk tempo caches bypassed. Measurements vary with system load and are not universal memory limits for longer recordings.
- All three recordings preserve the entire tempo map and every beat timestamp exactly. Existing cache version remains valid.
- In the two-lane desktop fixture, paused waveform paints over1.5s dropped from360 total to0. Sampled renderer CPU fell from5.64% to about0.03%; this is a fixture measurement, not whole-app CPU across all machines.
- Python regressions:12 pass, including all three real recordings. Default tests:4 pass. Audio/storage/tempo tests:42 pass. Typecheck, production build, desktop integration and diff whitespace checks pass.
- Independent focused review found no concrete issues, including the final subprocess thread limits.
- No audio stretching settings or algorithm changed. First-run JIT compilation and much longer recordings were not benchmarked.
