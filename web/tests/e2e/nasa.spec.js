// v3 NASA layers on synthetic data: level change (GUNW), drivers (GPM/CYGNSS/SME2),
// canopy (GEDI), terrain gate (NASADEM), optical water (DSWx-HLS), SWOT.
import { expect, test } from "@playwright/test";

const BASE = "index.html?data=data-synthetic&basemap=off&site=atchafalaya";
async function ready(page, q = "") {
  await page.goto(BASE + q);
  await expect(page.locator("body.is-ready")).toBeAttached();
}

test("level-change view and section", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await ready(page, "&pass=p05&view=level");
  await expect(page.locator(".overlay-level")).toBeVisible();
  await expect(page.locator(".legend-ramp")).toContainText("Change in water level under the canopy");
  const sec = page.locator('[data-feature="level"]');
  await expect(sec).toContainText(/water (rose|fell) about [\d.,]+ cm/);
  await expect(sec.locator(".bar")).not.toHaveCount(0);
  expect(errors).toEqual([]);
});

test("canopy view, legend and detection chart", async ({ page }) => {
  await ready(page, "&view=canopy");
  await expect(page.locator(".overlay-canopy")).toBeVisible();
  await expect(page.locator(".legend-ramp")).toContainText("GEDI");
  await expect(page.locator('[data-feature="canopy"] .bar-hidden')).not.toHaveCount(0);
});

test("drivers: rain bars, CYGNSS line and soil moisture", async ({ page }) => {
  await ready(page);
  const sec = page.locator('[data-feature="drivers"]');
  await expect(sec).toContainText("mm of rain fell");
  await expect(sec.locator(".rain")).not.toHaveCount(0);
  await expect(sec.locator(".line-cygnss")).toHaveCount(1);
  await expect(sec.locator(".dot-soil")).toHaveCount(14);
});

test("optical water in the reveal and chart; SWOT in validation", async ({ page }) => {
  await ready(page, "&pass=p08");
  await expect(page.locator(".area-chart .dot-optical")).not.toHaveCount(0);
  await expect(page.locator('[data-feature="validation"] .swot-line')).toContainText("SWOT");
});

test("explainer shows canopy and level facts", async ({ page }) => {
  await ready(page, "&pass=p05&px=128,128");
  await expect(page.locator(".facts")).toContainText("Canopy (GEDI)");
});

test("views hide when a site lacks the v3 layers", async ({ page }) => {
  await page.route("**/data-synthetic/atchafalaya/summary.json", async (route) => {
    const res = await route.fetch();
    const s = await res.json();
    s.products.level_change = [];
    s.products.canopy = null;
    s.context = { rain_daily: [], rain_source: null, inundation_daily: [], inundation_source: null, soil_moisture: [], soil_moisture_source: null };
    await route.fulfill({ response: res, json: s });
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await ready(page, "&view=level");
  await expect(page).toHaveURL(/view=flood/);
  await expect(page.getByRole("button", { name: "Level change" })).toBeDisabled();
  await expect(page.locator('[data-feature="level"]')).toBeHidden();
  await expect(page.locator('[data-feature="drivers"]')).toBeHidden();
  await expect(page.locator('[data-feature="canopy"]')).toBeHidden();
  expect(errors).toEqual([]);
});

test("v4: reference-map agreement and deprivation are reported", async ({ page }) => {
  await ready(page);
  await expect(page.locator('[data-feature="validation"]')).toContainText(/% of pixels agree/);
  await expect(page.locator('[data-feature="exposure"]')).toContainText("SEDAC");
});

test("v4: explainer shows C-band VV on a pass with an RTC-S1 match", async ({ page, request }) => {
  const s = await (await request.get("data-synthetic/atchafalaya/summary.json")).json();
  const p = s.passes.find((x) => x.rtc_date);
  test.skip(!p, "no synthetic RTC-S1 match in this build");
  await ready(page, `&pass=${p.id}&px=128,128`);
  await expect(page.locator(".facts")).toContainText("C-band radar here");
  await expect(page.locator(".series-chart .dot-vv")).not.toHaveCount(0);
});

test("v5: calibration line reports the held-out score and why a tuned rule was not used", async ({ page }) => {
  const fv = { held_out_before: 0.567, held_out_after: 0.779, label_sources: ["USFWS National Wetlands Inventory"] };
  const ow = { applied: false, held_out_before: 0.5, held_out_after: 0.5, rejected: null, label_sources: [] };
  for (const [cal, expected] of [
    [{ ...fv, applied: true, rejected: null }, /National Wetlands Inventory: 78% balanced accuracy.*\(57% with textbook/],
    [{ ...fv, applied: false, rejected: "gauge_timing" }, /57% balanced accuracy.*below the 70%.*scored 78%.*river gauge/],
  ]) {
    await page.route("**/data-synthetic/atchafalaya/summary.json", async (route) => {
      const res = await route.fetch();
      const s = await res.json();
      s.validation.calibration = { flooded_veg: cal, open_water: ow };
      await route.fulfill({ response: res, json: s });
    });
    await ready(page);
    await expect(page.locator(".cal-line")).toContainText(expected);
    await page.unrouteAll();
  }
});
