import importlib.util
import os
import pathlib
import unittest

import numpy as np

spec = importlib.util.spec_from_file_location('tempo', pathlib.Path(__file__).with_name('tempo.py'))
tempo = importlib.util.module_from_spec(spec) if spec else None
if spec and pathlib.Path(spec.origin).exists():
    spec.loader.exec_module(tempo)


def rhythm(bpm, seconds=36, sr=22050):
    audio = np.zeros(int(seconds * sr), dtype=np.float32)
    for beat, time in enumerate(np.arange(0.1, seconds - 0.1, 60 / bpm)):
        first = int(time * sr)
        length = min(int(0.08 * sr), len(audio) - first)
        t = np.arange(length) / sr
        # Broadband attacks with a backbeat accent, rather than single-sample pulses.
        tone = sum(np.sin(2 * np.pi * frequency * t) for frequency in (90, 650, 1800, 4000)) / 4
        audio[first:first + length] += tone * np.exp(-t * 70) * (1 if beat % 2 == 0 else 0.9)
    return audio


class TempoTests(unittest.TestCase):
    def test_blocked_onset_matches_librosa_at_boundaries(self):
        random = np.random.default_rng(7)
        for length in (4096, 22050 * 3 + 13):
            for audio in (np.zeros(length, dtype=np.float32),
                          random.normal(size=length).astype(np.float32)):
                expected = tempo.librosa.onset.onset_strength(y=audio, sr=22050, hop_length=128)
                for block_frames in (23, 1024):
                    actual = tempo.blocked_onset_strength(audio, 22050, 128, block_frames)
                    np.testing.assert_allclose(actual, expected, rtol=1e-6, atol=1e-6)
                    self.assertEqual(actual.dtype, expected.dtype)

    def test_bounded_medians_match_without_mutating_tempogram(self):
        random = np.random.default_rng(10)
        data = random.random((97, 257))
        original = data.copy()
        active = random.random(257) > 0.2
        expected = np.median(data[:, active], axis=-1)
        np.testing.assert_array_equal(tempo.median_strength(data, active), expected)
        np.testing.assert_array_equal(data, original)

    def test_blocked_tempogram_matches_librosa_at_boundaries(self):
        random = np.random.default_rng(42)
        for length in (1, 31, 2049):
            for win_length in (16, 17):
                for onset in (np.zeros(length, dtype=np.float32),
                              random.random(length).astype(np.float32)):
                    expected = tempo.librosa.feature.tempogram(onset_envelope=onset, win_length=win_length)
                    for block_frames in (1, 23, 1024):
                        with self.subTest(length=length, window=win_length, block=block_frames):
                            actual = tempo.blocked_tempogram(onset, win_length, block_frames)
                            np.testing.assert_allclose(actual, expected, rtol=1e-12, atol=1e-12)
                            self.assertEqual(actual.dtype, expected.dtype)

    def test_library_tracks_steady_grooves_and_rejects_silence(self):
        self.assertTrue(hasattr(tempo, 'analyze_audio'), 'Librosa analysis is missing')
        for bpm in (90, 126, 150):
            points = tempo.analyze_audio(rhythm(bpm), 22050)['points']
            self.assertTrue(points)
            for point in points:
                self.assertAlmostEqual(point['bpm'], bpm, delta=2)
        self.assertEqual(tempo.analyze_audio(np.zeros(22050 * 36, dtype=np.float32), 22050), {'points': [], 'beats': []})

    def test_strong_eighth_notes_keep_the_accented_quarter_note_pulse(self):
        # Alternating accents define a 139 BPM pulse over 278 attacks per minute.
        result = tempo.analyze_audio(rhythm(278), 22050)
        self.assertTrue(result['points'])
        for point in result['points']:
            self.assertAlmostEqual(point['bpm'], 139, delta=2)
        self.assertAlmostEqual(float(np.median(np.diff(result['beats']))), 60 / 139, delta=0.02)

    def test_short_louder_fill_does_not_accelerate_the_metronome(self):
        sr = 22050
        audio = rhythm(139)
        audio[8 * sr:11 * sr] += 3 * rhythm(180, seconds=3)
        result = tempo.analyze_audio(audio, sr)
        self.assertEqual(len(result['points']), 1)
        self.assertAlmostEqual(result['points'][0]['bpm'], 139, delta=2)
        beats = np.asarray(result['beats'])
        gaps = np.diff(beats[(beats >= 6) & (beats < 13)])
        self.assertGreater(len(gaps), 10)
        expected = 60 / 139
        self.assertTrue(np.all((gaps >= expected * 0.9) & (gaps <= expected * 1.1)),
                        f'The fill pulled clicks off the song pulse: {gaps}')

    def test_keeps_a_sustained_tempo_change(self):
        self.assertTrue(hasattr(tempo, 'analyze_audio'), 'Librosa analysis is missing')
        audio = np.concatenate([rhythm(90, 60), rhythm(150, 60)])
        points = tempo.analyze_audio(audio, 22050)['points']
        self.assertAlmostEqual(points[0]['bpm'], 90, delta=2)
        self.assertAlmostEqual(points[-1]['bpm'], 150, delta=2)
        self.assertTrue(any(48 <= point['start'] <= 72 for point in points[1:]))

    def test_silent_intro_and_outro_cannot_create_a_tempo_change(self):
        silence = np.zeros(22050 * 40, dtype=np.float32)
        points = tempo.analyze_audio(np.concatenate([silence, rhythm(90, 60), silence]), 22050)['points']
        self.assertTrue(points)
        for point in points:
            self.assertAlmostEqual(point['bpm'], 90, delta=2)

    def test_beats_keep_song_phase_and_follow_a_sustained_tempo_change(self):
        audio = np.concatenate([rhythm(90, 60), rhythm(150, 60)])
        result = tempo.analyze_audio(audio, 22050)
        beats = np.asarray(result['beats'])
        self.assertTrue(np.all(np.diff(beats) > 0))
        self.assertGreater(len(beats), 150)
        self.assertGreaterEqual(beats[0], 0)
        self.assertLess(beats[-1], 120)
        for start, end, bpm in [(10, 40, 90), (85, 110, 150)]:
            section = beats[(beats >= start) & (beats < end)]
            self.assertAlmostEqual(float(np.median(np.diff(section))), 60 / bpm, delta=0.025)
            self.assertLess(float(np.median(np.abs((section - 0.1) / (60 / bpm) - np.round((section - 0.1) / (60 / bpm))))), 0.1)

    @unittest.skipUnless(os.environ.get('STEMKIT_SO_FAR_AWAY_FIXTURE'), 'Set STEMKIT_SO_FAR_AWAY_FIXTURE to the local So Far Away mix.wav')
    def test_so_far_away_uses_139_instead_of_double_time(self):
        result = tempo.analyze_file(os.environ['STEMKIT_SO_FAR_AWAY_FIXTURE'])
        self.assertTrue(result['points'])
        for point in result['points']:
            self.assertAlmostEqual(point['bpm'], 139, delta=2)
        beats = np.asarray(result['beats'])
        self.assertAlmostEqual(float(np.median(np.diff(beats))), 60 / 139, delta=0.02)
        expected = 60 / 139
        around_eight = np.diff(beats[(beats >= 6) & (beats < 13)])
        self.assertGreater(len(around_eight), 10)
        self.assertTrue(np.all((around_eight >= expected * 0.9) & (around_eight <= expected * 1.1)),
                        f'Brief speed-up around 00:08: {around_eight}')
        gaps = np.diff(beats)
        self.assertTrue(np.all((gaps >= expected * 0.9) & (gaps <= expected * 1.1)),
                        f'Steady-song beat intervals range from {gaps.min()} to {gaps.max()}')

    @unittest.skipUnless(os.environ.get('STEMKIT_FOR_YOU_FIXTURE'), 'Set STEMKIT_FOR_YOU_FIXTURE to the local For You mix.wav')
    def test_for_you_uses_the_fast_pulse_instead_of_110(self):
        result = tempo.analyze_file(os.environ['STEMKIT_FOR_YOU_FIXTURE'])
        self.assertTrue(result['points'])
        for point in result['points']:
            self.assertAlmostEqual(point['bpm'], 163, delta=2)
        beats = np.asarray(result['beats'])
        self.assertAlmostEqual(float(np.median(np.diff(beats))), 60 / 163, delta=0.02)

    @unittest.skipUnless(os.environ.get('STEMKIT_TEMPO_FIXTURE'), 'Set STEMKIT_TEMPO_FIXTURE to the local Raining Again mix.wav')
    def test_raining_again_stays_126_including_intro_and_outro(self):
        self.assertTrue(hasattr(tempo, 'analyze_file'), 'Librosa analysis is missing')
        points = tempo.analyze_file(os.environ['STEMKIT_TEMPO_FIXTURE'])['points']
        self.assertEqual(points, [{'start': 0, 'bpm': 126}])


if __name__ == '__main__':
    unittest.main()
