import json
import subprocess
import sys
import tempfile
import unittest
import wave
from pathlib import Path

import numpy as np

PYTHON_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PYTHON_DIR))

from separate import save_wav_f32  # noqa: E402

SR = 44100


def note_freq(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)


def tone(midi, dur):
    # fundamental + octave only: higher partials (3rd = a fifth above) would smear
    # extra pitch classes and make the test signals key-ambiguous
    t = np.arange(int(SR * dur)) / SR
    f = note_freq(midi)
    return np.sin(2 * np.pi * f * t) + 0.5 * np.sin(2 * np.pi * 2 * f * t)


def chord(midis, dur):
    return sum(tone(m, dur) for m in midis)


def a_minor_signal():
    # Am (A3 C4 E4) alternating with Dm/E context, plus the A natural minor scale
    am = chord([57, 60, 64], 1.0)
    dm = chord([62, 65, 69], 1.0)
    em = chord([64, 67, 71], 1.0)
    scale = np.concatenate([tone(m, 0.25) for m in [57, 59, 60, 62, 64, 65, 67, 69]])
    return np.concatenate([am, dm, am, em, am, dm, am, am, scale]).astype(np.float32)


def g_major_signal():
    # sustained G triad over a G bass, framed by the G major scale and a G-C-D-G
    # cadence so the tonic outweighs the dominant (D) that the triad's 5th suggests
    g = chord([43, 55, 59, 62], 3.0)
    c = chord([48, 55, 60, 64], 1.0)
    d = chord([50, 57, 62, 66], 1.0)
    scale = np.concatenate([tone(m, 0.25) for m in [55, 57, 59, 60, 62, 64, 66, 67]])
    return np.concatenate([g, scale, c, d, g]).astype(np.float32)


def write_wav16(path, mono):
    pcm = (np.clip(mono / np.max(np.abs(mono)), -1, 1) * 0.5 * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def run_cli(*inputs):
    cmd = [sys.executable, str(PYTHON_DIR / "key.py")]
    for p in inputs:
        cmd += ["--input", str(p)]
    return subprocess.run(cmd, capture_output=True, text=True)


class KeyDetectionTest(unittest.TestCase):
    def test_a_minor_chord_progression(self):
        from key import detect_key

        tonic, mode = detect_key(a_minor_signal(), SR)
        self.assertEqual((tonic, mode), (9, "minor"))

    def test_g_major_triad(self):
        from key import detect_key

        tonic, mode = detect_key(g_major_signal(), SR)
        self.assertEqual((tonic, mode), (7, "major"))

    def test_white_noise_gives_a_flat_chroma(self):
        # noise has no pitch: every pitch class must weigh about the same. FFT
        # bins are linear in frequency, so between 55 Hz and 2 kHz A gets ~2x
        # the bins of C#; summing bins per pitch class made the bin layout,
        # not the music, decide the key
        from key import chroma

        rng = np.random.default_rng(0)
        vec = chroma(rng.standard_normal(SR * 20).astype(np.float32), SR)
        self.assertLess(vec.max() / vec.min(), 1.15)

    def test_d_flat_major_progression(self):
        # C#/Db gets the fewest FFT bins: the key the old detector missed most
        from key import detect_key

        i = chord([49, 53, 56], 1.0)
        iv = chord([54, 58, 61], 1.0)
        v = chord([56, 60, 63], 1.0)
        scale = np.concatenate([tone(m, 0.25) for m in [49, 51, 53, 54, 56, 58, 60, 61]])
        sig = np.concatenate([i, iv, i, v, i, scale, i]).astype(np.float32)
        self.assertEqual(detect_key(sig, SR), (1, "major"))

    def test_silence_fails(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "silence.wav"
            save_wav_f32(str(p), np.zeros((1, SR * 2), dtype=np.float32), SR)
            r = run_cli(p)
        self.assertEqual(r.returncode, 1)
        self.assertEqual(json.loads(r.stdout.strip().splitlines()[-1])["type"], "error")

    def test_mixed_widths(self):
        sig = g_major_signal()
        with tempfile.TemporaryDirectory() as d:
            a = Path(d) / "a16.wav"
            b = Path(d) / "b32.wav"
            write_wav16(a, sig)
            save_wav_f32(str(b), (sig / np.max(np.abs(sig)) * 0.5)[None, :], SR)
            r = run_cli(a, b)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        out = json.loads(r.stdout.strip().splitlines()[-1])
        self.assertEqual(out["type"], "key")
        self.assertEqual(out, {"type": "key", "tonic": 7, "mode": "major"})


if __name__ == "__main__":
    unittest.main()
