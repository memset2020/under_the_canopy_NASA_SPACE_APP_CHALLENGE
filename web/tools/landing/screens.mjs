// Screenshots of the app for the landing page's "Inside the app" tour (docs/10 D-084): the
// real app on the real data, one picture per mode, so the page shows the product instead of
// describing it. Re-run after an interface change:
//
//   node tools/landing/screens.mjs            # writes media/app-*.jpg
//
// Uses Playwright (a dev dependency) and the app's own static files; basemap tiles come from
// OpenStreetMap as in the app (add BASEMAP=off to leave them out). FILM_FONT_DIR, as for the
// film, gives the screenshots the app's own fonts.
import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml" };

// Each shot folds the map panel to its icons, so the map, the subject of every shot, gets the
// width (D-102). World is dragged from the Sahara to the Amazon and Congo, the flooded-forest
// belt the app is about, with the crosshair readout on the Amazon. Thresholds opens scientist
// mode and moves one slider, so the picture shows the map recomputed against the published one.
const fold = async (page) => {
  if (!(await page.evaluate(() => document.body.classList.contains("dock-folded")))) await page.locator(".dock-fold").first().click();
};
async function drag(page, dx, dy) {
  const b = await page.locator("#map").boundingBox();
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 12 });
  await page.mouse.up();
}

// [file, query, what to do once the page has settled]
const SHOTS = [
  ["app-site", "site=sylhet&compare=cband", fold],
  // app-world.jpg is the owner's own capture (Eurasia, 1920x1080 scaled to 1440x810); not retaken here.
  // app-evidence.jpg is the owner's own capture (Pará, NASA DIST-ANN beside the season of passes, 1920x1080 scaled to 1440x810); not retaken here.
  // app-ground.jpg is the owner's own capture (coherence with profile lines, 1920x1080 scaled to 1440x810); not retaken here.
  ["app-story", "site=sylhet", async (page) => (await fold(page), page.locator('[data-action="story"], .story-open').first().click())],
  [
    "app-tools",
    "site=sylhet&mode=tools",
    async (page) => {
      await fold(page);
      await page.getByRole("button", { name: "Adjust the thresholds" }).first().click();
      // Flooded vegetation, HH above: 1 dB lower than published, so more forest reads as flooded.
      await page.getByLabel("Flooded vegetation: HH above (dB)").fill("-5.5");
    },
  ],
];

function serve() {
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
    const file = resolve(WEB, `.${path}`);
    if (file !== WEB && !file.startsWith(WEB + sep)) return res.writeHead(403).end();
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

// The app's own fonts (Bahnschrift, Segoe UI), as in tools/film/render.mjs: FILM_FONT_DIR.
async function fontEnv() {
  const dir = process.env.FILM_FONT_DIR;
  if (!dir) return {};
  const tmp = await mkdtemp(join(tmpdir(), "screens-fonts-"));
  const conf = join(tmp, "fonts.conf");
  await writeFile(conf, `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>\n  <dir>${dir}</dir>\n  <cachedir>${join(tmp, "cache")}</cachedir>\n</fontconfig>\n`);
  return { FONTCONFIG_FILE: conf };
}

async function main() {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}/index.html`;
  const browser = await chromium.launch({ env: { ...process.env, ...(await fontEnv()) } });
  await mkdir(resolve(WEB, "media"), { recursive: true });
  try {
    for (const [name, query, act] of SHOTS) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
      const q = process.env.BASEMAP === "off" ? `${query}&basemap=off` : query;
      await page.goto(`${base}?${q}`, { waitUntil: "networkidle" });
      await page.waitForTimeout(1500);
      if (act) {
        await act(page);
        await page.waitForTimeout(1800);
      }
      const out = resolve(WEB, `media/${name}.jpg`);
      await page.screenshot({ path: out, type: "jpeg", quality: 82 });
      console.log(out);
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
