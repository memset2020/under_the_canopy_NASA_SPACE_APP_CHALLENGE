"""Voice-over for the opening film (docs/film/VOICEOVER.md, docs/10 D-114).

    python voice.py full|short --models DIR [--voice af_heart] [--speed 1.0] [--sample]

Reads the spoken text (docs/film/voiceover-*.txt, one paragraph a line) and the start and latest-end
time of each line (docs/film/voiceover-cues.json), synthesises each line with Kokoro (kokoro-onnx,
Apache-2.0, offline on the CPU), places it at its start time, lowers the score under the voice, and
muxes the result into a narrated copy of the film (media/intro-en-vo.mp4, media/pitch30-en-vo.mp4).
The picture is copied, not re-encoded. Also writes the WebVTT captions of the voice beside it.

Not a project dependency: like ffmpeg, Kokoro lives on the machine that renders (`pip install
kokoro-onnx soundfile`, and the model files kokoro-v1.0.onnx and voices-v1.0.bin in --models).
FFMPEG=/path/to/ffmpeg if ffmpeg is not on PATH. --sample writes three voices reading the first
line, to choose a voice before the full run.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

SR = 48_000
HERE = Path(__file__).resolve().parent
WEB = HERE.parents[1]
DOCS = WEB.parent / "docs" / "film"
# Score under the voice: -9 dB, 150 ms attack, 500 ms release (broadcast practice for a music bed).
DUCK_DB = -9.0
ATTACK_S = 0.15
RELEASE_S = 0.5
# A line may be sped up this much to fit its slot; beyond it the script must be cut instead.
MAX_SPEEDUP = 1.12


def paragraphs(path: Path) -> list[str]:
    text = path.read_text(encoding="utf-8").replace("\r\n", "\n")
    return [" ".join(p.split()) for p in text.split("\n\n") if p.strip()]


def resample(x: np.ndarray, sr_in: int) -> np.ndarray:
    """Linear resampling to SR (speech at 24 kHz to the film's 48 kHz; plenty for a voice)."""
    if sr_in == SR:
        return x
    t_out = np.arange(int(len(x) * SR / sr_in)) / SR
    return np.interp(t_out, np.arange(len(x)) / sr_in, x)


def trim(x: np.ndarray, floor: float = 0.01) -> np.ndarray:
    """Drop the model's leading and trailing near-silence, so a line starts on its cue."""
    idx = np.flatnonzero(np.abs(x) > floor * np.abs(x).max())
    if not idx.size:
        return x
    pad = int(0.03 * SR)
    return x[max(0, idx[0] - pad) : idx[-1] + pad]


def speak(tts, text: str, voice: str, speed: float, slot: float) -> tuple[np.ndarray, float]:
    """One line, sped up a little (at most MAX_SPEEDUP) if it would overrun its slot."""
    s = speed
    while True:
        audio, sr = tts.create(text, voice=voice, speed=s, lang="en-us")
        x = trim(resample(np.asarray(audio, dtype=np.float64), sr))
        if len(x) / SR <= slot or s >= speed * MAX_SPEEDUP - 1e-9:
            return x, s
        s = min(speed * MAX_SPEEDUP, s * (len(x) / SR) / slot + 0.01)


def duck_gain(vo: np.ndarray) -> np.ndarray:
    """Gain for the score: 1 where the voice is silent, DUCK_DB under it, with attack and release."""
    env = np.abs(vo) > 0.005
    hop = int(0.01 * SR)
    frames = env[: len(env) // hop * hop].reshape(-1, hop).any(axis=1).astype(float)
    target = 10 ** (DUCK_DB / 20)
    g = np.ones_like(frames)
    a = 1 - np.exp(-0.01 / ATTACK_S)
    r = 1 - np.exp(-0.01 / RELEASE_S)
    # Look ahead by the attack time, so the music is already down when the first word lands.
    lead = int(ATTACK_S / 0.01)
    ahead = np.lib.stride_tricks.sliding_window_view(np.concatenate([frames, np.zeros(lead)]), lead + 1).max(axis=1)
    want = np.where(ahead > 0, target, 1.0)
    for i in range(1, len(g)):
        k = a if want[i] < g[i - 1] else r
        g[i] = g[i - 1] + (want[i] - g[i - 1]) * k
    out = np.repeat(g, hop)
    return np.pad(out, (0, len(vo) - len(out)), mode="edge")


def vtt_time(t: float) -> str:
    h, rem = divmod(t, 3600)
    m, s = divmod(rem, 60)
    return f"{int(h):02d}:{int(m):02d}:{s:06.3f}"


def ffmpeg() -> str:
    return os.environ.get("FFMPEG", "ffmpeg")


def recorded(path: Path, slot: float) -> tuple[np.ndarray, float]:
    """A ready-made line (clone.py): trimmed, and if it overruns its slot, sped up at most MAX_SPEEDUP
    with ffmpeg's atempo, which keeps the pitch (a voice sped up by resampling would rise)."""
    x, sr = sf.read(path)
    x = trim(resample(np.asarray(x, dtype=np.float64).reshape(len(x), -1).mean(axis=1), sr))
    k = min(MAX_SPEEDUP, len(x) / SR / slot)
    if k <= 1.0:
        return x, 1.0
    raw = subprocess.run(
        [ffmpeg(), "-hide_banner", "-loglevel", "error", "-f", "f64le", "-ar", str(SR), "-ac", "1", "-i", "-", "-af", f"atempo={k:.4f}", "-f", "f64le", "-"],
        input=x.astype("<f8").tobytes(), capture_output=True, check=True,
    ).stdout
    return np.frombuffer(raw, dtype="<f8").copy(), k


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("cut", choices=["full", "short"])
    ap.add_argument("--models", help="folder with kokoro-v1.0.onnx and voices-v1.0.bin")
    # Ready-made lines (line_01.wav ...) from clone.py instead of Kokoro; --credit names the voice.
    ap.add_argument("--lines")
    ap.add_argument("--credit", default=None)
    ap.add_argument("--voice", default="af_heart")
    ap.add_argument("--speed", type=float, default=1.0)
    ap.add_argument("--sample", action="store_true")
    # Output suffix, so versions sit side by side: intro-en-<suffix>.mp4 (default "vo").
    ap.add_argument("--suffix", default="vo")
    ap.add_argument("--sample-voices", default="af_heart,bf_emma,am_michael")
    o = ap.parse_args()

    if not (o.lines or o.models):
        sys.exit("give --models (Kokoro) or --lines (clone.py output)")
    tts = None
    if not o.lines:
        from kokoro_onnx import Kokoro

        models = Path(o.models)
        tts = Kokoro(str(models / "kokoro-v1.0.onnx"), str(models / "voices-v1.0.bin"))
    credit = o.credit or f"Kokoro ({o.voice})"
    cues = json.loads((DOCS / "voiceover-cues.json").read_text(encoding="utf-8"))[o.cut]
    lines = paragraphs(DOCS / cues["text"])
    if len(lines) != len(cues["lines"]):
        sys.exit(f"{cues['text']} has {len(lines)} paragraphs but the cues list {len(cues['lines'])}")

    if o.sample:
        for v in o.sample_voices.split(","):
            x, _ = speak(tts, lines[0] + " " + lines[1], v, o.speed, 99)
            out = models / f"vo-sample-{v}.wav"  # beside the model, not in the published media/
            sf.write(out, x, SR, subtype="PCM_16")
            print(out)
        return

    video = WEB / "media" / cues["video"]
    probe = subprocess.run([ffmpeg(), "-hide_banner", "-i", str(video)], capture_output=True, text=True).stderr
    dur = next(float(h) * 3600 + float(m) * 60 + float(s) for ln in probe.splitlines() if "Duration:" in ln for h, m, s in [ln.split("Duration:")[1].split(",")[0].strip().split(":")])
    n = int(np.ceil(dur * SR))
    vo = np.zeros(n)
    vtt = ["WEBVTT", ""]
    for i, (text, (a, b)) in enumerate(zip(lines, cues["lines"])):
        x, used = recorded(Path(o.lines) / f"line_{i + 1:02d}.wav", b - a) if o.lines else speak(tts, text, o.voice, o.speed, b - a)
        i0 = int(a * SR)
        x = x[: n - i0]
        vo[i0 : i0 + len(x)] += x
        end = a + len(x) / SR
        flag = "" if end <= b + 0.05 else f"  OVERRUNS by {end - b:.2f} s: cut the line"
        print(f"{i + 1:2d} {a:6.1f}-{end:6.1f} (slot to {b:.1f}) speed {used:.2f}{flag}")
        vtt += [f"{i + 1}", f"{vtt_time(a)} --> {vtt_time(end)}", text, ""]

    # Space Apps asks that AI-generated audio say so: the last caption does, besides the metadata.
    last = end
    if dur - last >= 1.0:
        vtt += [f"{len(lines) + 1}", f"{vtt_time(last + 0.2)} --> {vtt_time(dur)}", f"[Voice synthesised by AI: {credit}]", ""]

    with tempfile.TemporaryDirectory() as work:
        score = Path(work) / "score.wav"
        subprocess.run([ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-i", str(video), "-vn", "-ac", "2", "-ar", str(SR), str(score)], check=True)
        music, _ = sf.read(score)
        music = np.pad(music, ((0, max(0, n - len(music))), (0, 0)))[:n]
        # The voice sits a little forward of centre-level: peak-normalise it to -3 dBFS.
        vo *= 10 ** (-3 / 20) / max(np.abs(vo).max(), 1e-9)
        mix = music * duck_gain(vo)[:, None] + vo[:, None]
        mix *= min(1.0, 10 ** (-1 / 20) / np.abs(mix).max())
        mixed = Path(work) / "mix.wav"
        sf.write(mixed, mix, SR, subtype="PCM_16")
        out = video.with_name(f"{video.stem}-{o.suffix}.mp4")
        subprocess.run([ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-i", str(video), "-i", str(mixed), "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-metadata", f"comment=Voice-over synthesised by AI: {credit}", str(out)], check=True)
    vtt_path = video.with_name(f"{video.stem}-{o.suffix}.vtt")
    vtt_path.write_text("\n".join(vtt), encoding="utf-8", newline="\n")
    print(f"→ {out}\n→ {vtt_path}")


if __name__ == "__main__":
    main()
