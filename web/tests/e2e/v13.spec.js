// Contract v13 (docs/14): ground that moved, burned forest, and the switch between the changes.
// These run on the real data in web/data (the events and the fire site have no synthetic twin).
import { expect, test } from "@playwright/test";

const ready = async (page, query) => {
  await page.goto(`index.html?basemap=off${query}`);
  await expect(page.locator("body.is-ready")).toBeAttached();
};

async function clickMapCentre(page) {
  const box = await page.locator("#map").boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

test("Ground mode: the earthquake shows east-west motion, fringes, a profile and the checks", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await ready(page, "&mode=motion");
  const card = page.locator('[data-feature="motion"]');
  await expect(card).toBeVisible();
  // Ground is reached from the header switch only; the rail no longer repeats it (D-080).
  await expect(page.locator('.changes-switch [data-kind="ground"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".rail-btn[data-mode=\"motion\"]")).toHaveCount(0);
  await page.selectOption("#motion-event", "venezuela_2026");
  await expect(card.locator(".motion-lead")).toContainText("M7.5");
  // Drawn in the browser from the planes (D-082): a canvas, a legend with ticks and the noise band.
  await expect(page.locator("canvas.overlay-motion")).toBeAttached();
  await expect(page.locator(".motion-legend")).toContainText("noise (2σ)"); // the key, under Layer in the map panel
  await expect(card.locator(".motion-thumb")).toHaveCount(6); // east, up and four tracks, one scale
  // Before and across the quake in the bar under the map (D-090), on one colour scale.
  // Before, the rupture in 5 s steps (USGS model), and across the quake, on one bar (D-091).
  const qbar = page.locator(".mode-timeline:not([hidden])");
  await expect(qbar.locator(".timeline-date")).toHaveText("Across the quake");
  expect(await qbar.locator(".tbar-model").count()).toBeGreaterThan(10);
  await qbar.locator('input[type="range"]').fill("8");
  await expect(qbar.locator(".timeline-date")).toHaveText("35 s into the rupture");
  await expect(page.locator(".rupture-patch.is-slipping").first()).toBeAttached();
  await qbar.locator('input[type="range"]').fill("0");
  await expect(qbar.locator(".timeline-date")).toHaveText("Before the quake");
  await expect(page.locator("#motion-range option:checked")).toContainText("±80");
  await page.selectOption("#motion-layer", "los_162A");
  await page.selectOption("#motion-style", "half");
  await expect(page.locator(".motion-legend")).toContainText("12.1 cm");
  await clickMapCentre(page);
  await expect(card.locator(".motion-point h3")).toContainText("°N");
  await expect(card.locator(".motion-facts li").first()).toContainText("Track");
  // The profile crosses the modelled fault; the checks name the held-out track.
  const profile = page.locator('[data-feature="motionprofile"]');
  await page.selectOption("#motion-layer", "east");
  await expect(profile.locator(".profile-model")).toBeAttached();
  await expect(profile.locator(".profile-fault")).toBeAttached();
  const checks = page.locator('[data-feature="motionchecks"]');
  await expect(checks).toContainText("JPL");
  await expect(checks.locator(".checks-held")).toContainText("126");
  await checks.getByRole("button", { name: /radar minus model/ }).click();
  await expect(page.locator("#motion-layer")).toHaveValue("resid:los_126D:model_los_126D");
  expect(errors).toEqual([]);
});

test("Ground mode: the sinking city gives a time series with GNSS, a time slider and a profile", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await ready(page, "&mode=motion");
  const card = page.locator('[data-feature="motion"]');
  await page.selectOption("#motion-event", "mexico_city");
  // Mexico City's stack is the largest motion file; on a loaded test server it takes over 5 s.
  await expect(card.locator(".motion-lead")).toContainText("cm a year", { timeout: 15000 });
  const checks = page.locator('[data-feature="motionchecks"]');
  await expect(checks).toContainText("MMX1");
  await checks.getByRole("button", { name: /MMX1/ }).click();
  await expect(card.locator(".motion-series")).toBeVisible();
  await expect(card.locator(".motion-series-key")).toContainText("GNSS station MMX1");
  await page.selectOption("#motion-layer", "cum:019A");
  // The season plays in the bar under the map, as Water and Fire do (D-089).
  const bar = page.locator(".mode-timeline:not([hidden])");
  await expect(bar).toBeVisible();
  await expect(card.locator(".motion-time")).toHaveCount(0);
  await bar.locator('input[type="range"]').fill("0");
  await expect(bar.locator(".timeline-caption")).toContainText("to May 10, 2026");
  await expect(page.locator('[data-feature="motionprofile"] .profile-median').first()).toBeAttached();
  expect(errors).toEqual([]);
});

test("a fire site opens on its burned forest with the MODIS check", async ({ page }) => {
  await ready(page, "&site=thunder_bay_36");
  const card = page.locator('[data-feature="burn"]');
  await expect(card).toBeVisible();
  await expect(card.locator(".burn-lead")).toContainText("km²");
  await expect(card).toContainText("MODIS");
  await expect(page.locator('.layers-card [data-view="burn"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".overlay-burn")).toBeAttached();
  await expect(card).toContainText("east half");
  await expect(card.locator(".burn-lookalike")).toContainText("look like flood");
});

test("a fire site sets the flood cards and flood-only views aside, and a flood site gets them back", async ({ page }) => {
  await ready(page, "&site=thunder_bay_36");
  await expect(page.locator("body")).toHaveAttribute("data-change", "fire");
  await expect(page.locator('[data-feature="exposure"]')).toBeHidden();
  await expect(page.locator('[data-feature="chart"]')).toBeHidden();
  await expect(page.locator('.layers-card [data-view="hydroperiod"]')).toBeHidden();
  await page.locator('.layers-card [data-view="flood"]').click();
  await expect(page.locator('.layers-card .legend-warn')).toContainText("burned forest");
  await page.locator('.changes-switch [data-kind="water"]').click();
  await expect(page.locator("body")).toHaveAttribute("data-change", "water");
  await expect(page.locator('[data-feature="chart"]')).toBeVisible();
  await expect(page.locator('.layers-card [data-view="hydroperiod"]')).toBeVisible();
});

test("the change switch moves between water, fire and ground", async ({ page }) => {
  await ready(page, "&site=sylhet");
  const sw = page.locator(".changes-switch");
  await expect(sw.locator('[data-kind="water"]')).toHaveAttribute("aria-pressed", "true");
  await sw.locator('[data-kind="fire"]').click();
  await expect(page.locator("#site-select")).toHaveValue("thunder_bay_36");
  await expect(sw.locator('[data-kind="fire"]')).toHaveAttribute("aria-pressed", "true");
  await sw.locator('[data-kind="ground"]').click();
  await expect(page.locator("body")).toHaveAttribute("data-mode", "motion");
  await sw.locator('[data-kind="water"]').click();
  await expect(page.locator("body")).toHaveAttribute("data-mode", "site");
  await expect(page.locator("#site-select")).not.toHaveValue("thunder_bay_36");
});
