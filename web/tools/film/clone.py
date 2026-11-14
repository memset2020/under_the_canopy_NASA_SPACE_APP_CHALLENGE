"""The narrator's own voice for the opening film, cloned from a recording (docs/film/VOICEOVER.md, D-115).

    python clone.py --sample ../sampleToClone.mp3 --work DIR [--cut full|short] [--takes 4]

Only for a voice whose owner has agreed: the owner recorded the sample for this film.

1. Reference: the sample is made mono, its steady background noise is reduced (noisereduce, stationary,
   gentle so the voice keeps its character), its loudness is evened, and faster-whisper transcribes it.
   Windows of 9-14 s of continuous, confidently transcribed speech are scored (speech share, level,
   transcription confidence); the best few are tried as references, and the one whose clone sounds
   most like the whole sample (speaker-embedding similarity) is kept.
2. Lines: each paragraph of docs/film/voiceover-*.txt is generated `--takes` times by Chatterbox
   (Resemble AI, MIT) with different seeds. faster-whisper transcribes every take; a take whose words
   differ from the script (slurred, skipped or invented words) is rejected. Of the rest, the take most
   like the narrator wins, preferring takes short enough for the line's slot (voiceover-cues.json).
3. Output: DIR/<cut>/line_NN.wav, and DIR/<cut>/report.json with every take's scores. voice.py
   --lines DIR/<cut> then places, fits, ducks, mixes and captions them like any other voice.

Render-machine tools only (D-115): torch, chatterbox-tts, faster-whisper, noisereduce, soundfile; never
imported by the app or the pipeline. FFMPEG=/path/to/ffmpeg for decoding the sample.
"""

from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf

HERE = Path(__file__).resolve().parent
DOCS = HERE.parents[2] / "docs" / "film"
# Calm documentary delivery: Chatterbox's defaults are 0.5 / 0.5; a little less exaggeration keeps a
# narrator steady, and cfg 0.5 keeps the pace close to the reference's own.
EXAGGERATION = 0.45
CFG_WEIGHT = 0.5
TEMPERATURE = 0.75
MIN_TEXT_MATCH = 0.88  # share of the script's words a take must say, after normalising numbers


# ---------------------------------------------------------------- text matching

ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()


def cardinal(n: int) -> str:
    if n < 20:
        return ONES[n]
    if n < 100:
        return TENS[n // 10] + ("" if n % 10 == 0 else " " + ONES[n % 10])
    if n < 1000:
        return ONES[n // 100] + " hundred" + ("" if n % 100 == 0 else " " + cardinal(n % 100))
    for size, name in ((10**9, "billion"), (10**6, "million"), (1000, "thousand")):
        if n >= size:
            return cardinal(n // size) + " " + name + ("" if n % size == 0 else " " + cardinal(n % size))
    return str(n)


def spoken_number(tok: str) -> str:
    """Whisper writes numbers as digits; the script spells them. Years are read as pairs."""
    tok = tok.replace(",", "")
    if re.fullmatch(r"(19|20)\d\d", tok):
        return cardinal(int(tok[:2])) + " " + (cardinal(int(tok[2:])) if tok[2:] != "00" else "hundred")
    if re.fullmatch(r"\d+\.\d+", tok):
        whole, frac = tok.split(".")
        return cardinal(int(whole)) + " point " + " ".join(ONES[int(d)] for d in frac)
    if tok.isdigit():
        return cardinal(int(tok))
    return tok


def normalise(text: str) -> list[str]:
    text = text.lower().replace("%", " percent").replace("-", " ")
    words = []
    for tok in re.findall(r"[a-z']+|\d[\d,]*(?:\.\d+)?", text):
        words += spoken_number(tok).split() if tok[0].isdigit() else [tok.strip("'")]
    # Whisper spells American, the script British: metre/meter, kilometres/kilometers.
    words = [re.sub(r"tre(s?)$", r"ter\1", w) for w in words]
    return [w for w in words if w and w != "and"]


def text_match(script: str, heard: str) -> float:
    a, b = normalise(script), normalise(heard)
    return difflib.SequenceMatcher(None, a, b).ratio() if a else 0.0


# ---------------------------------------------------------------- audio helpers

def decode(path: Path, sr: int) -> np.ndarray:
    exe = os.environ.get("FFMPEG", "ffmpeg")
    raw = subprocess.run([exe, "-hide_banner", "-loglevel", "error", "-i", str(path), "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).astype(np.float64)


def resample(x: np.ndarray, sr_in: int, sr_out: int) -> np.ndarray:
    if sr_in == sr_out:
        return x
    t = np.arange(int(len(x) * sr_out / sr_in)) / sr_out
    return np.interp(t, np.arange(len(x)) / sr_in, x)


def trim(x: np.ndarray, sr: int, floor: float = 0.02) -> np.ndarray:
    idx = np.flatnonzero(np.abs(x) > floor * np.abs(x).max())
    if not idx.size:
        return x
    pad = int(0.04 * sr)
    return x[max(0, idx[0] - pad) : idx[-1] + pad]


def clean_reference(x: np.ndarray, sr: int) -> np.ndarray:
    """Steady hiss and room tone out, gently (stationary spectral gating), then an even level."""
    import noisereduce as nr

    y = nr.reduce_noise(y=x, sr=sr, stationary=True, prop_decrease=0.75, n_fft=1024)
    y = y - y.mean()
    return y * (10 ** (-20 / 20) / max(np.sqrt(np.mean(y**2)), 1e-9))  # about -20 dBFS RMS


# ---------------------------------------------------------------- the clone

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--cut", choices=["full", "short", "both"], default="both")
    ap.add_argument("--takes", type=int, default=4)
    ap.add_argument("--refs", type=int, default=3, help="reference windows to try")
    o = ap.parse_args()

    import gc
    import time
    from concurrent.futures import ThreadPoolExecutor

    import torch
    from chatterbox.tts import ChatterboxTTS
    from faster_whisper import WhisperModel

    work = Path(o.work)
    work.mkdir(parents=True, exist_ok=True)
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    # Measured on the RTX 3050 (4 GB): fp32 with TF32 matmuls and inference mode, 6.6 s a line;
    # plain fp32, 23 s; bf16/fp16 autocast, 37 s (its weight copies overflow 4 GB into system memory).
    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True
    torch.backends.cudnn.benchmark = True
    print(f"device: {dev} {torch.cuda.get_device_name(0) if dev == 'cuda' else ''}", flush=True)

    # 1. The reference ----------------------------------------------------------
    SR_REF = 24_000
    full = clean_reference(decode(Path(o.sample), SR_REF), SR_REF)
    sf.write(work / "sample_clean.wav", full, SR_REF, subtype="PCM_16")
    # The one long transcription runs on the GPU, and Whisper is then unloaded entirely: Whisper and
    # Chatterbox together overflow a 4 GB card, and Windows then spills into system memory (a sentence
    # took 15 minutes). The per-take checks later run on the CPU, in parallel with the GPU.
    t0 = time.time()
    asr_gpu = WhisperModel("small.en", device=dev, compute_type="float16" if dev == "cuda" else "int8")
    segs = list(asr_gpu.transcribe(str(work / "sample_clean.wav"), language="en", vad_filter=True)[0])
    del asr_gpu
    gc.collect()
    if dev == "cuda":
        torch.cuda.empty_cache()
    print(f"sample transcribed in {time.time() - t0:.0f} s ({len(segs)} segments)", flush=True)
    (work / "sample_transcript.txt").write_text("\n".join(f"{s.start:7.2f} {s.end:7.2f} {s.text.strip()}" for s in segs), encoding="utf-8")
    asr = WhisperModel("small.en", device="cpu", compute_type="int8", cpu_threads=max(2, (os.cpu_count() or 4) - 2))
    # Windows of consecutive segments, 9-14 s, no pause longer than 0.8 s inside.
    cands = []
    for i in range(len(segs)):
        j, score_lp = i, []
        while j < len(segs) and segs[j].end - segs[i].start <= 14:
            if j > i and segs[j].start - segs[j - 1].end > 0.8:
                break
            score_lp.append(segs[j].avg_logprob)
            j += 1
            a, b = segs[i].start, segs[j - 1].end
            if b - a >= 9:
                clip = full[int(a * SR_REF) : int(b * SR_REF)]
                frames = clip[: len(clip) // 480 * 480].reshape(-1, 480)
                rms = np.sqrt((frames**2).mean(axis=1))
                speech = float((rms > 0.25 * np.median(rms[rms > 0])).mean())
                clipped = float((np.abs(clip) > 0.98).mean())
                cands.append({"a": round(a, 2), "b": round(b, 2), "speech": speech, "logprob": float(np.mean(score_lp)), "score": speech + 0.5 * float(np.mean(score_lp)) - 50 * clipped})
    cands.sort(key=lambda c: -c["score"])
    picked = []
    for c in cands:  # the best few that do not overlap
        if all(c["b"] <= p["a"] or c["a"] >= p["b"] for p in picked):
            picked.append(c)
        if len(picked) == o.refs:
            break
    if not picked:
        raise SystemExit("no 9-14 s stretch of continuous speech found in the sample")

    tts = ChatterboxTTS.from_pretrained(device=dev)

    def gen(text: str, seed: int) -> np.ndarray:
        torch.manual_seed(seed)
        with torch.inference_mode():
            w = tts.generate(text, exaggeration=EXAGGERATION, cfg_weight=CFG_WEIGHT, temperature=TEMPERATURE)
        return trim(w.float().squeeze().cpu().numpy().astype(np.float64), tts.sr)

    def heard(wav: np.ndarray) -> str:  # runs on the CPU thread
        return " ".join(s.text for s in asr.transcribe(resample(wav, tts.sr, 16_000).astype(np.float32), language="en")[0]).strip()

    def embed(wav: np.ndarray, sr: int) -> np.ndarray:
        e = tts.ve.embeds_from_wavs([resample(wav, sr, 16_000).astype(np.float32)], sample_rate=16_000)
        e = np.asarray(e).reshape(-1)
        return e / np.linalg.norm(e)

    target = embed(full, SR_REF)  # the narrator, from the whole cleaned sample
    test = "Every twelve days, its radar sees through cloud, day and night, and maps the water under the trees."
    for k, c in enumerate(picked):
        path = work / f"ref_{k}.wav"
        sf.write(path, full[int(c["a"] * SR_REF) : int(c["b"] * SR_REF)], SR_REF, subtype="PCM_16")
        tts.prepare_conditionals(str(path), exaggeration=EXAGGERATION)
        sims = [float(embed(gen(test, seed), tts.sr) @ target) for seed in (1, 2)]
        c["clone_similarity"] = float(np.mean(sims))
        c["path"] = str(path)
        print(f"reference {k}: {c['a']:.1f}-{c['b']:.1f} s  speech {c['speech']:.2f}  clone similarity {c['clone_similarity']:.3f}", flush=True)
    best = max(picked, key=lambda c: c["clone_similarity"])
    tts.prepare_conditionals(best["path"], exaggeration=EXAGGERATION)
    print(f"using reference {best['a']:.1f}-{best['b']:.1f} s", flush=True)

    # 2. The lines: the GPU generates take after take without waiting; each take's word check runs on
    # the CPU thread meanwhile, and the choice per line is made once everything is generated.
    cues_all = json.loads((DOCS / "voiceover-cues.json").read_text(encoding="utf-8"))
    cuts = ["full", "short"] if o.cut == "both" else [o.cut]
    jobs = []  # (cut, line index, text, slot, takes)
    for cut in cuts:
        cues = cues_all[cut]
        text = (DOCS / cues["text"]).read_text(encoding="utf-8").replace("\r\n", "\n")
        lines = [" ".join(p.split()) for p in text.split("\n\n") if p.strip()]
        jobs += [(cut, i, line, b - a, []) for i, (line, (a, b)) in enumerate(zip(lines, cues["lines"]))]
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=1) as cpu:
        for n, (cut, i, line, slot, takes) in enumerate(jobs):
            for seed in range(o.takes):
                w = gen(line, 1000 * i + seed)
                takes.append({"seed": seed, "dur": round(len(w) / tts.sr, 2), "similarity": round(float(embed(w, tts.sr) @ target), 4), "fits": len(w) / tts.sr <= slot * 1.12, "wav": w, "heard": cpu.submit(heard, w)})
            left = (time.time() - t0) / (n + 1) * (len(jobs) - n - 1)
            print(f"generated {cut} {i + 1:2d} ({n + 1}/{len(jobs)} lines, about {left / 60:.0f} min left)", flush=True)
        for _, _, line, _, takes in jobs:
            for tk in takes:
                tk["heard"] = tk["heard"].result()
                tk["match"] = round(text_match(line, tk["heard"]), 3)

    for cut in cuts:
        out = work / cut
        out.mkdir(exist_ok=True)
        report = {"reference": best, "settings": {"exaggeration": EXAGGERATION, "cfg_weight": CFG_WEIGHT, "temperature": TEMPERATURE, "tf32": True}, "lines": []}
        for _, i, line, slot, takes in (j for j in jobs if j[0] == cut):
            ok = [t for t in takes if t["match"] >= MIN_TEXT_MATCH] or sorted(takes, key=lambda t: -t["match"])[:1]
            fitting = [t for t in ok if t["fits"]] or sorted(ok, key=lambda t: t["dur"])[:1]
            win = max(fitting, key=lambda t: t["similarity"])
            sf.write(out / f"line_{i + 1:02d}.wav", win["wav"], tts.sr, subtype="PCM_16")
            flag = "" if win["match"] >= MIN_TEXT_MATCH else "  CHECK WORDS"
            flag += "" if win["fits"] else "  TOO LONG"
            print(f"{cut} {i + 1:2d}: take {win['seed']} of {len(takes)}  {win['dur']:.1f}/{slot:.1f} s  words {win['match']:.2f}  voice {win['similarity']:.3f}{flag}", flush=True)
            report["lines"].append({"line": i + 1, "text": line, "slot": round(slot, 2), "chosen": win["seed"], "takes": [{k: v for k, v in t.items() if k != "wav"} for t in takes]})
        (out / "report.json").write_text(json.dumps(report, indent=1, ensure_ascii=False), encoding="utf-8", newline="\n")
        print(f"→ {out}")


if __name__ == "__main__":
    main()
