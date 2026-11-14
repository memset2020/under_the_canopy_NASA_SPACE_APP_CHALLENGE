"""Soundtrack for the opening film (docs/10 D-084), synthesised from the film's own cues.

    python3 score.py cues.json out.wav

cues.json comes from film.html (window.film.cues()): when each scene starts, when a number
settles, when each radar pass of the fire lands. The score is a slow pad that changes chord
with each scene, a soft sonar ping on each settled number (a radar echo, the film's subject),
a quiet tick for every fire pass, a rise under the NISAR reveal and a low bloom under the
title. numpy only (the pipeline's core dependency); 48 kHz stereo, 16-bit.
"""

from __future__ import annotations

import json
import sys
import wave

import numpy as np

SR = 48_000

# One chord per scene (MIDI notes). The 2022 opening sits low and dark (D minor, C minor, B flat);
# NISAR's arrival lifts to A minor; the reveal and the title resolve to C major (docs/film/SCRIPT.md).
CHORDS = {
    "cold": [38, 45, 50, 53],
    "toll": [36, 43, 48, 51, 55],
    "blind": [34, 41, 46, 50, 53],
    "hook": [45, 52, 57, 59, 60, 64],
    "zoom": [41, 48, 57, 64, 67],
    "camera": [38, 50, 57, 60, 64, 65],
    "cband": [38, 50, 57, 60, 62, 65],
    "nisar": [36, 48, 55, 60, 62, 64, 67],
    "physics": [45, 52, 55, 60, 64],
    "people": [41, 48, 57, 64, 67],
    "fire": [38, 50, 57, 64, 65],
    "ground": [40, 47, 50, 55, 59],
    "season": [43, 50, 55, 59, 62],
    "card": [41, 48, 57, 60, 64],
    "places": [36, 48, 55, 60, 64, 67],
    "ice": [40, 47, 52, 55, 59, 64],
    "proof": [41, 48, 57, 60, 64],
    "limits": [38, 50, 57, 60, 65],
    "audience": [41, 48, 57, 64, 67],
    "index": [43, 50, 55, 62, 67],
    "next": [45, 52, 57, 60, 64, 69],
    "title": [36, 48, 55, 62, 64, 67, 72],
}


def hz(midi: float) -> float:
    return 440.0 * 2 ** ((midi - 69) / 12)


def raised(x: np.ndarray) -> np.ndarray:
    """0 → 1 raised-cosine ramp for x in [0, 1]."""
    x = np.clip(x, 0, 1)
    return 0.5 - 0.5 * np.cos(np.pi * x)


def pad(
    n: int, scenes: list[tuple[str, float, float]], rng: np.random.Generator
) -> np.ndarray:
    out = np.zeros((n, 2))
    fade = 1.6
    for sid, a, b in scenes:
        notes = CHORDS.get(sid)
        if not notes:
            continue
        i0 = max(0, int((a - fade) * SR))
        i1 = min(n, int((b + fade) * SR))
        t = np.arange(i0, i1) / SR
        env = raised((t - (a - fade / 2)) / fade) * (
            1 - raised((t - (b - fade / 2)) / fade)
        )
        for k, m in enumerate(notes):
            f = hz(m)
            # Warm, soft voice: a fundamental, two quiet partials, and two copies a hair apart.
            ph = rng.uniform(0, 2 * np.pi)
            voice = np.zeros_like(t)
            for det in (-0.12, 0.12):
                w = 2 * np.pi * (f + det) * t + ph
                voice += np.sin(w) + 0.22 * np.sin(2 * w) + 0.07 * np.sin(3 * w)
            amp = (0.9 if m < 48 else 0.55) / len(notes)
            pan = 0.5 + 0.35 * ((k / max(1, len(notes) - 1)) - 0.5)
            out[i0:i1, 0] += voice * env * amp * (1 - pan)
            out[i0:i1, 1] += voice * env * amp * pan
    return out


def ping(out: np.ndarray, at: float, f: float, gain: float, decay: float = 0.9) -> None:
    i0 = int(at * SR)
    if i0 >= len(out):
        return
    t = np.arange(min(len(out) - i0, int(decay * 6 * SR))) / SR
    env = np.exp(-t / decay) * raised(t / 0.006)
    tone = np.sin(2 * np.pi * f * t) + 0.18 * np.sin(2 * np.pi * 2.01 * f * t) * np.exp(
        -t / (decay * 0.4)
    )
    out[i0 : i0 + len(t), 0] += tone * env * gain
    out[i0 : i0 + len(t), 1] += tone * env * gain * 0.9


def swell(out: np.ndarray, at: float, rng: np.random.Generator) -> None:
    """A soft rise into the reveal: filtered noise that opens up, and a high shimmer."""
    pre = 1.8
    i0 = max(0, int((at - pre) * SR))
    i1 = min(len(out), int((at + 2.6) * SR))
    t = np.arange(i0, i1) / SR - at
    noise = rng.standard_normal((len(t), 2))
    # Moving-average low-pass whose window shrinks as the rise opens (brighter towards `at`).
    k = 64
    c = np.cumsum(noise, axis=0)
    smooth = (c[k:] - c[:-k]) / k
    smooth = np.vstack([smooth, np.zeros((k, 2))])
    env = raised((t + pre) / pre) * np.exp(-np.clip(t, 0, None) / 0.7)
    out[i0:i1] += smooth * env[:, None] * 0.05
    for m in (84, 88, 91):
        f = hz(m)
        tt = np.clip(t, 0, None)
        sh = (
            np.sin(2 * np.pi * f * tt) * raised(tt / 0.4) * np.exp(-tt / 1.6) * (t >= 0)
        )
        out[i0:i1, 0] += sh * 0.018
        out[i0:i1, 1] += sh * 0.018


def bloom(out: np.ndarray, at: float) -> None:
    """A low, soft hit under the title."""
    i0 = int(at * SR)
    t = np.arange(min(len(out) - i0, int(3.5 * SR))) / SR
    f = 55 * (1 + 0.5 * np.exp(-t / 0.08))
    boom = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 1.1) * raised(t / 0.01)
    out[i0 : i0 + len(t)] += boom[:, None] * 0.28


def rumble(out: np.ndarray, at: float, dur: float, rng: np.random.Generator) -> None:
    """Water rising under the opening quote: heavily low-passed noise that swells and settles."""
    i0 = int(at * SR)
    i1 = min(len(out), int((at + dur + 2.0) * SR))
    t = np.arange(i1 - i0) / SR
    noise = rng.standard_normal((len(t), 2))
    k = 900  # ~19 ms moving average twice: a dull, deep wash
    for _ in range(2):
        c = np.cumsum(noise, axis=0)
        noise = np.vstack([(c[k:] - c[:-k]) / k, np.zeros((k, 2))])
    env = raised(t / dur) * (1 - raised((t - dur) / 2.0))
    out[i0:i1] += noise * env[:, None] * 1.6


def toll(out: np.ndarray, at: float) -> None:
    """A low bell for the number of people affected: two inharmonic partials, a slow decay."""
    i0 = int(at * SR)
    t = np.arange(min(len(out) - i0, int(4.5 * SR))) / SR
    env = np.exp(-t / 1.5) * raised(t / 0.004)
    tone = (
        np.sin(2 * np.pi * 73.4 * t)
        + 0.5 * np.sin(2 * np.pi * 73.4 * 2.76 * t) * np.exp(-t / 0.6)
        + 0.25 * np.sin(2 * np.pi * 73.4 * 5.4 * t) * np.exp(-t / 0.3)
    )
    out[i0 : i0 + len(t)] += (tone * env)[:, None] * 0.16


def reverb(
    dry: np.ndarray, rng: np.random.Generator, seconds: float = 2.6, wet: float = 0.32
) -> np.ndarray:
    n = int(seconds * SR)
    t = np.arange(n) / SR
    ir = (
        rng.standard_normal((n, 2)) * np.exp(-t * 6.9 / seconds)[:, None]
    )  # -60 dB at `seconds`
    ir[: int(0.02 * SR)] = 0  # pre-delay
    ir /= np.sqrt((ir**2).sum(axis=0))
    size = 1 << int(np.ceil(np.log2(len(dry) + n)))
    out = np.empty_like(dry)
    for ch in range(2):
        spec = np.fft.rfft(dry[:, ch], size) * np.fft.rfft(ir[:, ch], size)
        out[:, ch] = np.fft.irfft(spec, size)[: len(dry)]
    return (1 - wet) * dry + wet * out


def render(duration: float, cues: list[dict]) -> np.ndarray:
    rng = np.random.default_rng(2026)
    n = int(np.ceil(duration * SR))
    scenes_at = [(c["id"], c["t"]) for c in cues if c["kind"] == "scene"]
    scenes = [
        (sid, a, scenes_at[i + 1][1] if i + 1 < len(scenes_at) else duration)
        for i, (sid, a) in enumerate(scenes_at)
    ]
    mix = pad(n, scenes, rng) * 0.9
    for c in cues:
        if c["kind"] == "ping":
            ping(
                mix, c["t"], hz(81 + [0, 3, 5, 7, 10][int(c.get("note", 0)) % 5]), 0.06
            )
        elif c["kind"] == "pass":
            ping(
                mix,
                c["t"],
                hz(76 + int(c.get("note", 0))),
                0.03 * float(c.get("gain", 1)),
                decay=0.35,
            )
        elif c["kind"] in ("swell", "turn"):
            swell(mix, c["t"], rng)
        elif c["kind"] == "rumble":
            rumble(mix, c["t"], float(c.get("d", 5.0)), rng)
        elif c["kind"] == "toll":
            toll(mix, c["t"])
        elif c["kind"] == "hit":
            bloom(mix, c["t"])
    mix = reverb(mix, rng)
    t = np.arange(n) / SR
    mix *= (
        raised(t / 1.2)[:, None] * (1 - raised((t - (duration - 2.0)) / 2.0))[:, None]
    )
    mix = np.tanh(mix * 1.6) / np.tanh(1.6)  # gentle soft clip
    peak = np.abs(mix).max()
    if peak > 0:
        mix *= (
            10 ** (-3 / 20) / peak
        )  # -3 dBFS peak: a quiet bed under a pitch, not a song
    return mix


def write_wav(path: str, audio: np.ndarray) -> None:
    pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def main() -> None:
    cue_file, out = sys.argv[1], sys.argv[2]
    with open(cue_file, encoding="utf-8") as f:
        spec = json.load(f)
    audio = render(float(spec["duration"]), spec["cues"])
    write_wav(out, audio)
    rms = float(np.sqrt((audio**2).mean()))
    print(
        f"score: {len(audio) / SR:.1f} s, RMS {20 * np.log10(max(rms, 1e-9)):.1f} dBFS → {out}"
    )


if __name__ == "__main__":
    main()
