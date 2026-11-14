// Landing page (landing.html, docs/10 D-083, D-084): the film plays muted and can be stopped,
// numbers and charts come from the published data, every control works by keyboard, it leads
// into the app in the chosen language, and it fits a phone.
import { test, expect } from "@playwright/test";

test("the page loads cleanly and the film starts muted, with a way to stop it", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto("landing.html");
  const video = page.locator("#film-video");
  await expect(video).toHaveJSProperty("muted", true);
  await expect.poll(() => video.evaluate((v) => v.currentSrc)).toContain("media/intro-en");
  await expect(page.locator("#film-play")).toBeVisible();
  await page.locator("#film-play").click();
  await expect.poll(() => video.evaluate((v) => v.paused)).toBe(true);
  await expect(page.locator("#film-play span")).toHaveText("Play the film");
  expect(errors).toEqual([]);
});

test("English plays the narrated film, with captions once the sound is on (D-115)", async ({ page }) => {
  await page.goto("landing.html");
  const video = page.locator("#film-video");
  await expect.poll(() => video.evaluate((v) => v.currentSrc)).toContain("media/intro-en-vo-clone.mp4");
  const mode = () => video.evaluate((v) => v.textTracks[0]?.mode);
  await expect.poll(mode).toBe("hidden");
  await page.locator("#film-sound").click();
  await expect(video).toHaveJSProperty("muted", false);
  await expect.poll(mode).toBe("showing");
  await expect.poll(() => video.evaluate((v) => v.textTracks[0].cues?.length ?? 0)).toBeGreaterThan(20);
});

test("Bengali keeps the film without an English voice", async ({ page }) => {
  await page.goto("landing.html?lang=bn");
  const video = page.locator("#film-video");
  await expect.poll(() => video.evaluate((v) => v.currentSrc)).toContain("media/intro-bn.mp4");
  expect(await video.evaluate((v) => v.textTracks.length)).toBe(0);
});

test("people who ask for less motion get the title card, not a playing film", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("landing.html");
  const video = page.locator("#film-video");
  await expect(video).toHaveAttribute("poster", /intro-en\.jpg$/);
  await page.waitForTimeout(500);
  expect(await video.evaluate((v) => v.paused)).toBe(true);
});

test("the film stops when the page covers it", async ({ page }) => {
  await page.goto("landing.html");
  const video = page.locator("#film-video");
  await expect.poll(() => video.evaluate((v) => !v.paused)).toBe(true);
  await page.evaluate(() => window.scrollTo(0, document.getElementById("problem").offsetTop));
  await expect.poll(() => video.evaluate((v) => v.paused)).toBe(true);
});

test("the hero reveal reads the real Sylhet pass", async ({ page }) => {
  await page.goto("landing.html");
  await page.locator("#hero").scrollIntoViewIfNeeded();
  await page.getByRole("tab", { name: "NISAR L-band" }).click();
  await expect(page.locator("#readout-num")).toHaveText("26.4 km²");
  await expect(page.locator("#readout-text")).toContainText("11.0 km²");
});

test("numbers, charts and the world map come from the published data", async ({ page }) => {
  await page.goto("landing.html");
  const manifest = await (await page.request.get("data/manifest.json")).json();
  const events = await (await page.request.get("data/motion/index.json")).json();
  const sylhet = await (await page.request.get("data/sylhet/summary.json")).json();
  const fire = await (await page.request.get("data/thunder_bay_36/summary.json")).json();
  await expect(page.locator('[data-num="burned"]')).toHaveText(Math.round(fire.products.burn.burned_km2).toLocaleString("en-US"));
  await expect(page.locator('[data-i18n="landing.cov_flood_how"]')).toHaveText(
    `Tracked at ${manifest.sites.filter((s) => (s.kind ?? "flood") === "flood").length} places`,
  );
  await expect(page.locator("#chart-river svg")).toBeVisible();
  await expect(page.locator("#chart-river table tbody tr")).toHaveCount(sylhet.validation.gauge.series.length);
  await expect(page.locator("#chart-burn svg")).toBeVisible();
  await expect(page.locator("#chart-gps svg")).toBeVisible();
  await expect(page.locator("#world-dots a")).toHaveCount(manifest.sites.length + events.events.length);
});

test("the picture follows the steps as you scroll", async ({ page }) => {
  await page.goto("landing.html");
  await page.locator('.step[data-step="lband"]').scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    const r = document.querySelector('.step[data-step="lband"]').getBoundingClientRect();
    window.scrollBy(0, r.top + r.height / 2 - innerHeight / 2);
  });
  await expect(page.locator("#sensors")).toHaveAttribute("data-step", "lband");
});

test("the app tour switches views by click and by arrow key", async ({ page }) => {
  await page.goto("landing.html");
  await expect(page.locator("#panel-site")).toBeVisible();
  await page.locator("#tab-world").click();
  await expect(page.locator("#panel-world")).toBeVisible();
  await expect(page.locator("#panel-site")).toBeHidden();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("#panel-evidence")).toBeVisible();
  await expect(page.locator("#tab-evidence")).toBeFocused();
});

test("links into the app keep the language, and the page fits a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("landing.html?lang=pt");
  await expect(page.locator("html")).toHaveAttribute("lang", "pt");
  const href = await page.locator(".change .btn").first().getAttribute("href");
  expect(href).toContain("site=sylhet");
  expect(href).toContain("lang=pt");
  await page.waitForTimeout(800);
  const [scroll, inner] = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  expect(scroll).toBeLessThanOrEqual(inner);
});

test("the app's wordmark leads back to the landing page", async ({ page }) => {
  await page.goto("index.html?data=data-synthetic");
  await expect(page.locator(".wordmark a")).toHaveAttribute("href", "landing.html");
});
