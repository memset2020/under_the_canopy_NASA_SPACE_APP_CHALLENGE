// Active fires (docs/10 D-138): NASA FIRMS detections from GIBS vector tiles, and the fire and
// smoke imagery in the live layers. GIBS is stubbed: no network in tests.
import { expect, test } from "@playwright/test";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");

// A minimal Mapbox Vector Tile (v2) with FIRMS-style point features.
function varint(n) {
  const out = [];
  while (n >= 128) {
    out.push((n % 128) | 128);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}
const tag = (field, wire) => varint(field * 8 + wire);
const ld = (field, bytes) => [...tag(field, 2), ...varint(bytes.length), ...bytes];
const utf8 = (s) => [...Buffer.from(s, "utf8")];
const zz = (n) => (n >= 0 ? 2 * n : -2 * n - 1);
function mvt(points) {
  const keys = [];
  const values = [];
  const index = (list, v) => (list.includes(v) ? list.indexOf(v) : list.push(v) - 1);
  const features = points.map((p) => {
    const tags = Object.entries(p).flatMap(([k, v]) => [index(keys, k), index(values, v)]);
    return [...ld(2, tags.flatMap(varint)), ...tag(3, 0), 1, ...ld(4, [9, zz(100), zz(100)].flatMap(varint))];
  });
  const value = (v) => (typeof v === "number" ? (() => { const b = Buffer.alloc(8); b.writeDoubleLE(v); return [...tag(3, 1), ...b]; })() : ld(1, utf8(v)));
  const layer = [
    ...tag(15, 0), 2,
    ...ld(1, utf8("VIIRS_NOAA20_Thermal_Anomalies_375m_All_v2_NRT")),
    ...features.flatMap((f) => ld(2, f)),
    ...keys.flatMap((k) => ld(3, utf8(k))),
    ...values.flatMap((v) => ld(4, value(v))),
    ...tag(5, 0), ...varint(4096),
  ];
  return Buffer.from(ld(3, layer));
}

// Two detections inside the Thunder Bay 36 box: a small one at night and a strong one by day.
const TILE = mvt([
  { LATITUDE: 50.4, LONGITUDE: -89.2, FRP: 3.9, ACQ_DATE: "2026-07-15", ACQ_TIME: "08:39", SATELLITE: "N20", CONFIDENCE: "nominal", DAYNIGHT: "N" },
  { LATITUDE: 50.5, LONGITUDE: -89.1, FRP: 142.5, ACQ_DATE: "2026-07-15", ACQ_TIME: "18:05", SATELLITE: "N20", CONFIDENCE: "high", DAYNIGHT: "D" },
]);

async function stub(page, fireUrls) {
  await page.route("https://gibs.earthdata.nasa.gov/**", (route) => {
    const url = route.request().url();
    if (url.includes("_Thermal_Anomalies_")) {
      fireUrls.push(url);
      return route.fulfill({ status: 200, contentType: "application/vnd.mapbox-vector-tile", headers: { "Access-Control-Allow-Origin": "*" }, body: TILE });
    }
    return route.fulfill({ status: 200, contentType: "image/png", body: PNG });
  });
  await page.route("https://tile.openstreetmap.org/**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG }));
}

const dayOf = (u) => u.match(/\/default\/(\d{4}-\d\d-\d\d)\//)?.[1];

test("active fires load for the days since the last radar pass, count what is in view, and change window", async ({ page }) => {
  const fireUrls = [];
  await stub(page, fireUrls);
  await page.goto("index.html?site=thunder_bay_36&pass=p04"); // 23 Jul 2026; the previous pass was 11 Jul
  await expect(page.locator("body.is-ready")).toBeAttached();
  const group = page.locator(".fires-group");
  await expect(group).toBeVisible();
  expect(fireUrls).toEqual([]); // nothing is fetched until the reader asks
  await page.locator("#fires-show").check();
  await expect(page.locator("#fires-window")).toHaveValue("pass");
  await expect(page.locator("#fires-date")).toHaveValue("2026-07-23");
  await expect.poll(() => new Set(fireUrls.map(dayOf))).toEqual(new Set(Array.from({ length: 12 }, (_, k) => `2026-07-${String(12 + k).padStart(2, "0")}`)));
  expect(fireUrls.every((u) => u.includes("/VIIRS_NOAA20_Thermal_Anomalies_375m_All/default/") && u.includes("/500m/"))).toBe(true);
  // The two detections are counted once, whichever tiles they came in.
  await expect(page.locator(".fires-status")).toContainText("2 fire detections in view");
  await expect(page.locator(".fires-status")).toContainText("1 by day, 1 by night");
  await expect(page.locator(".fires-status")).toContainText("Strongest: 143 MW");
  await expect(page.locator(".fires-legend li")).toHaveCount(4);
  fireUrls.length = 0;
  await page.selectOption("#fires-window", "1"); // just the pass day, from the cache: no new request
  await expect(page.locator(".fires-status")).toContainText("Jul 23, 2026 to Jul 23, 2026");
  expect(fireUrls).toEqual([]);
  await page.selectOption("#fires-sensor", "modis");
  await expect.poll(() => fireUrls.some((u) => u.includes("/MODIS_Combined_Thermal_Anomalies_All/"))).toBe(true);
  await page.locator("#fires-show").uncheck();
  await expect(page.locator(".fires-controls")).toBeHidden();
});

test("fire and smoke imagery is its own group of NASA live layers", async ({ page }) => {
  const fireUrls = [];
  await stub(page, fireUrls);
  await page.goto("index.html?site=thunder_bay_36");
  await expect(page.locator("body.is-ready")).toBeAttached();
  const group = page.locator('#live-layer optgroup[label="Fire and smoke"] option');
  await expect(group).toHaveCount(6);
  await page.selectOption("#live-layer", "VIIRS_NOAA20_CorrectedReflectance_BandsM11-I2-I1");
  await expect(page.locator(".map-live-layer")).toHaveCount(1);
});

test("offline (basemap=off) shows no fire control and asks for no fire tile", async ({ page }) => {
  const fireUrls = [];
  await stub(page, fireUrls);
  await page.goto("index.html?site=thunder_bay_36&basemap=off");
  await expect(page.locator("body.is-ready")).toBeAttached();
  await expect(page.locator(".fires-group")).toBeHidden();
  expect(fireUrls).toEqual([]);
});
