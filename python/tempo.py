"""Analyze the original mix with Librosa; never infer tempo from mixer settings."""
import argparse
import json

import librosa
import numpy as np


def blocked_onset_strength(audio, sr, hop, block_frames=1024):
    # Keep Librosa's centered STFT and global dB floor without a song-sized FFT.
    n_fft = 2048
    padded = np.pad(audio, (n_fft // 2,) * 2, mode='constant')
    frames = 1 + len(audio) // hop
    mel = np.empty((128, frames), dtype=audio.dtype)
    for first in range(0, frames, block_frames):
        last = min(first + block_frames, frames)
        mel[:, first:last] = librosa.feature.melspectrogram(
            y=padded[first * hop:(last - 1) * hop + n_fft], sr=sr,
            n_fft=n_fft, hop_length=hop, center=False)
    return librosa.onset.onset_strength(
        S=librosa.power_to_db(np.abs(mel)), sr=sr, hop_length=hop)


def median_strength(tempogram, active):
    # Boolean indexing makes a disposable copy; partition small row batches in place.
    strength = np.empty(tempogram.shape[0], dtype=tempogram.dtype)
    for first in range(0, len(strength), 32):
        last = min(first + 32, len(strength))
        strength[first:last] = np.median(tempogram[first:last, active], axis=-1, overwrite_input=True)
    return strength


def blocked_tempogram(onset, win_length, block_frames=1024):
    # Pad once for the whole song so block boundaries retain Librosa's exact phase.
    padded = np.pad(onset, (win_length // 2,) * 2, mode='linear_ramp', end_values=[0, 0])
    result = np.empty((win_length, len(onset)), dtype=np.float64)
    for first in range(0, len(onset), block_frames):
        last = min(first + block_frames, len(onset))
        result[:, first:last] = librosa.feature.tempogram(
            onset_envelope=padded[first:last + win_length - 1],
            win_length=win_length, center=False)
    return result


def analyze_audio(audio, sr):
    if len(audio) < sr * 2 or not np.isfinite(audio).all() or np.max(np.abs(audio)) < 1e-5:
        return {'points': [], 'beats': []}
    hop = 128
    onset = blocked_onset_strength(audio, sr, hop)
    # Short correlation windows favor the beat over longer rhythmic phrases.
    tempogram = blocked_tempogram(onset, int(4 * sr / hop))
    frequencies = librosa.tempo_frequencies(tempogram.shape[0], sr=sr, hop_length=hop)
    valid = (frequencies >= 30) & (frequencies <= 300)
    active = np.max(tempogram[valid], axis=0) > 1e-4
    if not np.any(active):
        return {'points': [], 'beats': []}
    # Librosa's broad tempo prior helps distinguish the beat from stronger subdivisions.
    bpm = librosa.feature.tempo(tg=median_strength(tempogram, active)[:, None], sr=sr, hop_length=hop,
                               aggregate=None, std_bpm=2, max_tempo=300)
    _, beats = librosa.beat.beat_track(onset_envelope=onset, sr=sr, hop_length=hop, bpm=bpm)
    reference = float(np.asarray(bpm).item())
    if len(beats) < 4 or not 30 <= reference <= 300:
        return {'points': [], 'beats': []}
    reference = round(reference)
    reference_index = int(np.argmin(np.abs(frequencies - reference)))
    duration = len(audio) / sr
    candidates = []
    for start in np.arange(0, max(1, duration - 24 + 0.001), 6):
        first, last = int(start * sr / hop), int((start + 24) * sr / hop)
        chunk = onset[first:last]
        local_tempogram = tempogram[:, first:last]
        local_active = active[first:last]
        if not np.any(local_active):
            candidates.append((float(start), None))
            continue
        strength = median_strength(local_tempogram, local_active)
        local_bpm = librosa.feature.tempo(tg=strength[:, None], sr=sr, hop_length=hop,
                                         aggregate=None, std_bpm=2, max_tempo=300)
        _, local_beats = librosa.beat.beat_track(onset_envelope=chunk, sr=sr, hop_length=hop, bpm=local_bpm)
        local = float(np.asarray(local_bpm).item())
        if len(local_beats) < 4 or not 30 <= local <= 300:
            candidates.append((float(start), None))
            continue
        # Keep the song pulse while it remains supported; harmonics can score slightly higher locally.
        supported = strength[reference_index] >= 0.7 * np.max(strength[valid])
        candidate = reference if supported or abs(local / reference - 1) <= 0.05 else round(local)
        candidates.append((float(start), candidate))

    points = [{'start': 0, 'bpm': reference}]
    index = 0
    while index < len(candidates):
        if candidates[index][1] is None:
            index += 1
            continue
        end = index + 1
        while end < len(candidates) and candidates[end][1] is not None and abs(candidates[end][1] / candidates[index][1] - 1) <= 0.03:
            end += 1
        # Require agreement in overlapping windows before accepting a tempo change.
        if end - index >= 2:
            value = round(float(np.median([candidate for _, candidate in candidates[index:end]])))
            if 30 <= value <= 300 and value != points[-1]['bpm']:
                start = 0 if index == 0 else candidates[index][0] + 12
                if start == 0:
                    points[0]['bpm'] = value
                else:
                    points.append({'start': start, 'bpm': value})
        index = end
    bpm_curve = np.full(len(onset), points[0]['bpm'], dtype=np.float64)
    for point in points[1:]:
        bpm_curve[int(point['start'] * sr / hop):] = point['bpm']
    # Keep transient accents from pulling metronome beats away from the accepted tempo map.
    _, tracked = librosa.beat.beat_track(onset_envelope=onset, sr=sr, hop_length=hop,
                                       bpm=bpm_curve, units='time', trim=False, tightness=3000)
    ticks = [float(beat) for beat in tracked if 0 <= beat < duration]
    if ticks:
        # Extend the detected phase through silent intros and outros.
        before = []
        first = ticks[0] - 60 / points[0]['bpm']
        while first >= 0:
            before.append(first)
            first -= 60 / points[0]['bpm']
        ticks = list(reversed(before)) + ticks
        last = ticks[-1] + 60 / points[-1]['bpm']
        while last < duration:
            ticks.append(last)
            last += 60 / points[-1]['bpm']
    return {'points': points, 'beats': [round(beat, 6) for beat in ticks]}


def analyze_file(path):
    audio, sr = librosa.load(path, sr=22050, mono=True)
    return analyze_audio(audio, sr)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    args = parser.parse_args()
    print(json.dumps(analyze_file(args.input)), flush=True)
