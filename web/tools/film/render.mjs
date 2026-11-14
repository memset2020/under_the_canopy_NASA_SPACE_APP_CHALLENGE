// Render the opening film (film.html, docs/10 D-084) to video. The composition is a pure
// function of time, so this steps it frame by frame in headless Chromium (Playwright, already
// a dev dependency) and pipes the frames to ffmpeg; nothing is captured in real time, so a
// slow machine makes the same film as a fast one. No new dependency: ffmpeg is a program on
// the machine (FFMPEG=/path/to/ffmpeg if it is not on PATH), the soundtrack comes from
// score.py (numpy).
//
//   node tools/film/render.mjs [--lang en|bn|pt] [--cut full|short] [--aspect landscape|portrait]
//                              [--out media/intro-en.mp4] [--poster media/intro-en.jpg]
//                              [--stills 0,4.5,12] [--crf 26] [--size 720x1280] [--silent]
//                              [--keep frames.mkv] [--from frames.mkv] [--maps media]
//
// Fonts: the film uses the app's stack (Bahnschrift, Segoe UI). Point FILM_FONT_DIR at a
// folder holding them (on Windows or WSL, copies from C:\Windows\Fonts); otherwise the stack
// falls back to the system's fonts and the film looks plainer.
import { chromium } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HERE = dirname(fileURLToPath(import.meta.url));

function args(argv) {
  const out = { lang: "en", cut: "full", aspect: "landscape", crf: 26, silent: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--silent") out.silent = true;
    else if (a.startsWith("--")) out[a.slice(2)] = argv[++i];
  }
  out.crf = Number(out.crf);
  return out;
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".bin": "application/octet-stream",
  ".gz": "application/octet-stream", // motion.bin.gz is undone by the page itself
};

// A static server for web/ (the page fetches its data like the app does).
function serve() {
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
    const file = resolve(WEB, `.${path}`);
    if (file !== WEB && !file.startsWith(WEB + sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

async function fontEnv() {
  const dir = process.env.FILM_FONT_DIR;
  if (!dir) return {};
  const tmp = await mkdtemp(join(tmpdir(), "film-fonts-"));
  const conf = join(tmp, "fonts.conf");
  await writeFile(
    conf,
    `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n` +
      `  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>\n` +
      `  <dir>${dir}</dir>\n  <cachedir>${join(tmp, "cache")}</cachedir>\n</fontconfig>\n`,
  );
  return { FONTCONFIG_FILE: conf };
}

function ffmpeg() {
  const exe = process.env.FFMPEG || "ffmpeg";
  const probe = spawnSync(exe, ["-version"], { encoding: "utf8" });
  if (probe.status !== 0) throw new Error(`ffmpeg not found (${exe}); set FFMPEG=/path/to/ffmpeg`);
  return exe;
}

async function main() {
  const o = args(process.argv.slice(2));
  const portrait = o.aspect === "portrait";
  const [W, H] = portrait ? [1080, 1920] : [1920, 1080];
  const tag = `${o.cut === "short" ? "pitch30" : "intro"}-${o.lang}${portrait ? "-portrait" : ""}`;
  const out = resolve(WEB, o.out ?? `media/${tag}.mp4`);
  const poster = resolve(WEB, o.poster ?? `media/${tag}.jpg`);
  const server = await serve();
  const port = server.address().port;
  const browser = await chromium.launch({ env: { ...process.env, ...(await fontEnv()) } });
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    page.on("console", (m) => m.type() === "error" && console.error("page:", m.text()));
    page.on("pageerror", (e) => console.error("page:", e.message));
    const q = new URLSearchParams({ lang: o.lang, cut: o.cut, aspect: o.aspect, render: "1" });
    await page.goto(`http://127.0.0.1:${port}/film.html?${q}`);
    await page.waitForFunction(() => window.film && (window.film.ready || window.film.error), null, { timeout: 180_000 });
    const info = await page.evaluate(() => (window.film.error ? { error: window.film.error } : {
      duration: window.film.duration, fps: window.film.fps, posterTime: window.film.posterTime, cues: window.film.cues(),
    }));
    if (info.error) throw new Error(info.error);

    if (o.maps) {
      // The motion maps for the landing page (media/map-*.jpg and their colour ranges).
      const maps = await page.evaluate(() => window.film.maps());
      const dir = resolve(WEB, o.maps);
      await mkdir(dir, { recursive: true });
      const meta = {};
      for (const [k, m] of Object.entries(maps)) {
        await writeFile(join(dir, `map-${k}.jpg`), Buffer.from(m.url.split(",")[1], "base64"));
        meta[k] = { file: `map-${k}.jpg`, lo: m.lo, hi: m.hi, width: m.width, height: m.height };
      }
      await writeFile(join(dir, "maps.json"), `${JSON.stringify(meta, null, 2)}\n`);
      console.log(`maps → ${dir}`);
      return;
    }

    if (o.stills) {
      await mkdir(dirname(out), { recursive: true });
      for (const s of o.stills.split(",").map(Number)) {
        await page.evaluate((x) => window.film.seek(x), s);
        const file = out.replace(/\.mp4$/, "") + `-${s.toFixed(2)}s.png`;
        await page.screenshot({ path: file });
        console.log(file);
      }
      return;
    }

    const exe = ffmpeg();
    const work = await mkdtemp(join(tmpdir(), "film-"));
    let audio = null;
    if (!o.silent) {
      const cueFile = join(work, "cues.json");
      audio = join(work, "score.wav");
      await writeFile(cueFile, JSON.stringify({ duration: info.duration, cues: info.cues }));
      const py = spawnSync(process.env.PYTHON || "python3", [join(HERE, "score.py"), cueFile, audio], { stdio: "inherit" });
      if (py.status !== 0) throw new Error("score.py failed");
    }
    await mkdir(dirname(out), { recursive: true });
    const n = Math.round(info.duration * info.fps);
    // 1. Frames, captured once and kept as the JPEGs themselves (no re-encode) in a Matroska
    //    file, so the film can be encoded again at another size or quality without recapture.
    const frames = o.from ? resolve(o.from) : join(work, "frames.mkv");
    if (!o.from) {
      const cap = spawn(exe, ["-hide_banner", "-loglevel", "error", "-y", "-f", "image2pipe", "-c:v", "mjpeg", "-framerate", String(info.fps), "-i", "-", "-c:v", "copy", frames], { stdio: ["pipe", "inherit", "inherit"] });
      const captured = new Promise((ok, fail) => cap.on("close", (c) => (c === 0 ? ok() : fail(new Error(`ffmpeg exited ${c}`)))));
      const t0 = Date.now();
      for (let i = 0; i < n; i++) {
        await page.evaluate((x) => window.film.seek(x), i / info.fps);
        const buf = await page.screenshot({ type: "jpeg", quality: 94 });
        if (!cap.stdin.write(buf)) await new Promise((ok) => cap.stdin.once("drain", ok));
        if (i % 60 === 0) process.stdout.write(`\r${tag}: frame ${i}/${n} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
      }
      cap.stdin.end();
      await captured;
      if (o.keep) await copyFile(frames, resolve(o.keep));
    }
    // 2. The film: H.264 plays in every browser. Phones get the portrait cut at 720 × 1280,
    //    plenty for a phone and half the bytes. Flat colour and gradients band at high CRF;
    //    -tune animation and a modest CRF keep them.
    const size = o.size ?? (portrait ? "720x1280" : null);
    const enc = ["-hide_banner", "-loglevel", "error", "-y", "-i", frames];
    if (audio) enc.push("-i", audio);
    enc.push("-map", "0:v");
    if (audio) enc.push("-map", "1:a", "-c:a", "aac", "-b:a", "128k");
    // The frames are full-range JPEGs; ffmpeg 7 keeps that range (yuvj420p) unless told, and some
    // players then show the film too contrasty or too flat. Always convert to TV range.
    enc.push("-vf", `scale=${size ? size.replace("x", ":") : "iw:ih"}:flags=lanczos:out_range=tv`);
    enc.push("-c:v", "libx264", "-preset", "slow", "-tune", "animation", "-crf", String(o.crf), "-pix_fmt", "yuv420p", "-color_range", "tv", "-profile:v", "high", "-movflags", "+faststart", "-t", info.duration.toFixed(3), out);
    const ff = spawnSync(exe, enc, { stdio: "inherit" });
    if (ff.status !== 0) throw new Error(`ffmpeg exited ${ff.status}`);
    await page.evaluate((x) => window.film.seek(x), info.posterTime);
    await page.screenshot({ path: poster, type: "jpeg", quality: 86 });
    process.stdout.write(`\r${tag}: ${n} frames, ${info.duration.toFixed(1)} s → ${out}\n`);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
