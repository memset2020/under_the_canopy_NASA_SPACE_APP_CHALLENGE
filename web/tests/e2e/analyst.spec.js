// New analyst views (D-065): tools, feature space, flows, ridgeline, basemaps and orbit tracks.
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const ready = async (page, query) => {
  await page.goto(`index.html?site=atchafalaya&data=data-synthetic&basemap=off${query}`);
  await expect(page.locator("body.is-ready")).toBeAttached();
};

test("tools: distance, area statistics with downloads, cross-section", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await ready(page, "&mode=tools");
  const box = await page.locator("#map").boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.getByRole("button", { name: "Distance" }).click();
  await page.mouse.click(cx - 80, cy);
  await page.mouse.click(cx + 80, cy);
  await page.getByRole("button", { name: "Finish" }).click();
  await expect(page.locator(".tool-figure")).toContainText(/km along the ground/);
  await page.getByRole("button", { name: "Area" }).click();
  for (const [dx, dy] of [[-60, -60], [60, -60], [60, 60], [-60, 60]]) await page.mouse.click(cx + dx, cy + dy);
  await page.getByRole("button", { name: "Finish" }).click();
  await expect(page.locator(".tool-figure")).toContainText(/km² on the ground/);
  await expect(page.locator(".tool-chart rect").first()).toBeAttached();
  await expect(page.getByRole("link", { name: "Download CSV" })).toHaveAttribute("download", /area\.csv$/);
  await page.getByRole("button", { name: "Cross-section" }).click();
  await page.mouse.click(cx - 70, cy - 40);
  await page.mouse.click(cx + 70, cy + 40);
  await expect(page.locator(".profile-chart path.profile-line")).toHaveCount(2);
  // A tool owns map clicks: "This spot" stays closed while drawing.
  await expect(page.locator('[data-feature="explain"] .explain-body')).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(page.locator("body")).not.toHaveClass(/is-drawing/);
  expect(errors).toEqual([]);
});

test("tools: the shown pass exports as GeoTIFF, named and marked synthetic", async ({ page }) => {
  await ready(page, "&mode=tools&pass=p05");
  const box = page.locator(".tool-export");
  await expect(box).toBeVisible();
  await expect(box).toContainText("EPSG:4326");
  for (const [label, kind] of [["Classes (GeoTIFF)", "classes"], ["Radar HH and HV in dB (GeoTIFF)", "hh_hv_db"]]) {
    const [dl] = await Promise.all([page.waitForEvent("download"), box.getByRole("button", { name: label }).click()]);
    expect(dl.suggestedFilename()).toMatch(new RegExp(`^atchafalaya_\\d{4}-\\d\\d-\\d\\d_${kind}_SYNTHETIC\\.tif$`));
    const head = readFileSync(await dl.path()).subarray(0, 4);
    expect(Array.from(head)).toEqual([0x49, 0x49, 42, 0]); // little-endian TIFF
  }
});

test("feature space: a brushed box lights pixels up on the map", async ({ page }) => {
  await ready(page, "&mode=tools");
  const svg = page.locator(".space-svg");
  await svg.scrollIntoViewIfNeeded();
  const r = await svg.boundingBox();
  await page.mouse.move(r.x + r.width * 0.3, r.y + r.height * 0.15);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width * 0.95, r.y + r.height * 0.8, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator(".space-readout")).toContainText(/km² of the map are in the box/);
  await expect(page.locator(".overlay-brush")).toBeVisible();
  await page.getByRole("button", { name: "Clear the box" }).click();
  await expect(page.locator(".overlay-brush")).toBeHidden();
});

test("evidence: flows add up and a ridge opens its pass", async ({ page }) => {
  await ready(page, "&mode=evidence");
  await expect(page.locator(".flows-lead")).toContainText(/km² of water under the trees/);
  await expect(page.locator(".flows-ribbon").first()).toBeAttached();
  await page.locator(".ridge").nth(1).click();
  await expect(page).toHaveURL(/pass=p02/);
});

test("offline: no basemap control and no orbit card", async ({ page }) => {
  await ready(page, "&mode=world");
  await expect(page.locator(".basemap-ctl")).toBeHidden();
  await expect(page.locator('[data-feature="orbits"]')).toBeHidden();
});

test("online: basemap switch and NISAR orbit tracks load from NASA GIBS", async ({ page }) => {
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
  const urls = [];
  await page.route("https://gibs.earthdata.nasa.gov/**", (route) => {
    urls.push(route.request().url());
    const mvt = route.request().url().endsWith(".mvt");
    return route.fulfill({ status: 200, contentType: mvt ? "application/octet-stream" : "image/png", headers: { "Access-Control-Allow-Origin": "*" }, body: mvt ? Buffer.alloc(0) : PNG });
  });
  await page.route("https://tile.openstreetmap.org/**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG }));
  await page.goto("index.html?site=sylhet&mode=world");
  await expect(page.locator("body.is-ready")).toBeAttached();
  await page.locator("#dock-h-basemap").click(); // the map panel's Basemap section opens (D-092)
  await expect(page.locator(".basemap-ctl")).toBeVisible();
  await expect(page.locator(".map-attribution")).toContainText("NASA Blue Marble"); // automatic in World mode
  await page.selectOption("#basemap-select", "night");
  await expect(page.locator(".map-attribution")).toContainText("NASA Black Marble");
  await expect.poll(() => urls.some((u) => u.includes("/VIIRS_Black_Marble/"))).toBe(true);
  await page.selectOption("#basemap-select", "streets");
  await expect(page.locator(".map-attribution")).toContainText("OpenStreetMap");
  const card = page.locator('[data-feature="orbits"]');
  await expect(card).toBeVisible();
  await page.locator("#orbit-nisar").check();
  await expect.poll(() => urls.some((u) => u.includes("/OrbitTracks_NISAR_") && u.endsWith(".mvt"))).toBe(true);
  await expect(card.locator(".orbit-crossing")).toContainText("12 days");
  await expect(card.locator(".orbit-sun")).toContainText(/night now/i); // the day-night line goes with the track
  // On a site, the sun at the radar's own time stamp (Sylhet's passes are at dawn or dusk).
  await page.locator(".world-btn").click(); // back from the world to the site
  await expect(card.locator(".orbit-sun")).toContainText(/local solar time and the sun stood \d+° (below|above) the horizon/);
});
