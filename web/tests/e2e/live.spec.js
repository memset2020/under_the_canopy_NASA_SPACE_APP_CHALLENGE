// F35 NASA live layers: tiles come from GIBS (stubbed here, no network in tests).
import { expect, test } from "@playwright/test";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");

test("a GIBS layer follows the radar pass date and snaps to available days", async ({ page }) => {
  const tiles = [];
  await page.route("https://gibs.earthdata.nasa.gov/**", (route) => {
    tiles.push(route.request().url());
    return route.fulfill({ status: 200, contentType: "image/png", body: PNG });
  });
  await page.route("https://tile.openstreetmap.org/**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG }));
  await page.goto("index.html?site=sylhet&pass=p03");
  await expect(page.locator("body.is-ready")).toBeAttached();
  const card = page.locator('.dock-item[data-owner="live"]'); // in the map panel's On top (D-092)
  await expect(card).toBeVisible();
  await page.selectOption("#live-layer", "MODIS_Combined_Flood_2-Day");
  await expect(page.locator("#live-date")).toHaveValue("2026-07-17");
  await expect.poll(() => tiles.some((u) => u.includes("/MODIS_Combined_Flood_2-Day/default/2026-07-17/"))).toBe(true);
  await page.locator("#live-date").fill("2026-08-01");
  await page.locator("#live-date").dispatchEvent("change");
  await expect(page.locator("#live-follow")).not.toBeChecked();
  await expect.poll(() => tiles.some((u) => u.includes("/2026-08-01/"))).toBe(true);
  await page.selectOption("#live-layer", "");
  await expect(page.locator(".map-live-layer")).toHaveCount(0);
});

test("offline (basemap=off) never requests NASA tiles", async ({ page }) => {
  const calls = [];
  await page.route("https://gibs.earthdata.nasa.gov/**", (route) => {
    calls.push(route.request().url());
    return route.abort();
  });
  await page.goto("index.html?site=sylhet&basemap=off");
  await expect(page.locator("body.is-ready")).toBeAttached();
  await expect(page.locator('.dock-item[data-owner="live"]')).toBeHidden();
  expect(calls).toEqual([]);
});

test("swath layers composite their repeat cycle, newest on top", async ({ page }) => {
  const tiles = [];
  await page.route("https://gibs.earthdata.nasa.gov/**", (route) => {
    tiles.push(route.request().url());
    return route.fulfill({ status: 200, contentType: "image/png", body: PNG });
  });
  await page.route("https://tile.openstreetmap.org/**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG }));
  await page.goto("index.html?site=sylhet&pass=p03");
  await expect(page.locator("body.is-ready")).toBeAttached();
  await page.selectOption("#live-layer", "NISAR_L2_Geocoded_Polarimetric_Covariance");
  await expect(page.locator("#live-fill")).toBeChecked();
  await expect(page.locator(".map-live-layer")).toHaveCount(12);
  // Dated tiles only: the place-name and road layers have no date.
  await expect.poll(() => new Set(tiles.map((u) => u.match(/\/(\d{4}-\d{2}-\d{2})\//)?.[1]).filter(Boolean)).size).toBe(12);
  await expect(page.locator(".map-label-layer")).toHaveCount(2);
  await page.locator("#live-labels").uncheck();
  await expect(page.locator(".map-label-layer")).toHaveCount(0);
  await expect(page.locator(".live-note")).toContainText("Nearest day on top");
  await page.locator("#live-fill").uncheck();
  await expect(page.locator(".map-live-layer")).toHaveCount(1);
});

test("GIBS tiles: a transient 500 is retried, an opaque black filler tile is hidden", async ({ page }) => {
  // GIBS sends an all-black opaque PNG for some no-data tiles and occasional HTTP 500s (docs/10 D-063).
  const BLACK = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAADElEQVR4nGNgGB4AAADIAAGtQHYiAAAAAElFTkSuQmCC", "base64");
  const cors = { "Access-Control-Allow-Origin": "*" };
  const seen = new Map();
  let first = null; // the first rain tile asked for fails once, then answers; every other tile is filler
  await page.route("https://gibs.earthdata.nasa.gov/**", (route) => {
    const url = route.request().url();
    if (url.includes("/IMERG_")) first ??= url;
    const n = (seen.get(url) ?? 0) + 1;
    seen.set(url, n);
    if (url === first) return route.fulfill(n === 1 ? { status: 500, headers: cors, body: "" } : { status: 200, contentType: "image/png", headers: cors, body: PNG });
    return route.fulfill({ status: 200, contentType: "image/png", headers: cors, body: BLACK });
  });
  await page.route("https://tile.openstreetmap.org/**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG }));
  await page.goto("index.html?site=sylhet&mode=world");
  await expect(page.locator("body.is-ready")).toBeAttached();
  await page.selectOption("#live-layer", "IMERG_Precipitation_Rate");
  const live = page.locator(".map-live-layer img");
  const shown = (wantFirst) => live.evaluateAll((im, [f, w]) => im.filter((i) => (i.src === f) === w && i.complete && i.naturalWidth && !i.classList.contains("map-tile-failed")).length, [first, wantFirst]);
  await expect.poll(() => seen.get(first) ?? 0).toBeGreaterThanOrEqual(2);
  await expect.poll(() => shown(true)).toBe(1);
  // Every other tile was the black filler: hidden, not drawn as a black square.
  await expect.poll(() => live.count()).toBeGreaterThan(1);
  await expect.poll(() => shown(false)).toBe(0);
});

test("GIBS tiles: a failing tile is hidden while it waits to retry, never a broken-image box", async ({ page }) => {
  const cors = { "Access-Control-Allow-Origin": "*" };
  let bad = null; // the first rain tile always answers HTTP 500
  await page.route("https://gibs.earthdata.nasa.gov/**", (route) => {
    const url = route.request().url();
    if (url.includes("/IMERG_")) bad ??= url;
    if (url === bad) return route.fulfill({ status: 500, headers: cors, body: "" });
    return route.fulfill({ status: 200, contentType: "image/png", headers: cors, body: PNG });
  });
  await page.route("https://tile.openstreetmap.org/**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG }));
  await page.goto("index.html?site=sylhet&mode=world");
  await expect(page.locator("body.is-ready")).toBeAttached();
  await page.selectOption("#live-layer", "IMERG_Precipitation_Rate");
  const live = page.locator(".map-live-layer img");
  await expect.poll(() => live.count()).toBeGreaterThan(1);
  // Through both retry waits (0.7 s and 1.4 s): a broken image (loaded, no pixels) is never visible.
  const visibleBroken = () =>
    live.evaluateAll((im) => im.filter((i) => i.getAttribute("src") && i.complete && !i.naturalWidth && getComputedStyle(i).visibility !== "hidden").length);
  // A broken image is marked complete a moment before its error handler runs: only one still
  // visible 50 ms later is a box a viewer could see.
  for (let k = 0; k < 14; k += 1) {
    if (await visibleBroken()) {
      await page.waitForTimeout(50);
      expect(await visibleBroken()).toBe(0);
    }
    await page.waitForTimeout(200);
  }
});
