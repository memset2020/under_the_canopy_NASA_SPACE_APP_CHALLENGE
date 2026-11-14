// Tier 2 features on synthetic data: F05, F08, F16, F15, F11.
import { expect, test } from "@playwright/test";

const BASE = "index.html?data=data-synthetic&basemap=off&site=atchafalaya&pass=p08";

async function ready(page, query = "") {
  await page.goto(BASE + query);
  await expect(page.locator("body.is-ready")).toBeAttached();
}

test("F05: gauge correlation with scatter of every pass", async ({ page }) => {
  await ready(page);
  const section = page.locator('[data-feature="validation"]');
  await expect(section).toContainText(/r = 0\.\d\d across 14 passes/);
  await expect(section.locator(".scatter .pt")).toHaveCount(14);
});

test("F08: place search answers 'is the forest near me flooded?'", async ({ page }) => {
  await ready(page);
  const section = page.locator('[data-feature="exposure"]');
  await expect(section).toContainText("people live within 1 km");
  await page.locator("#place-search").fill("demo village c");
  await page.locator("#place-search").press("Enter");
  await page.locator("#place-search").dispatchEvent("change");
  await expect(section.locator(".place-result")).toContainText("Demo village C (synthetic)");
  // Roads are off by default so dense networks never hide the flood map.
  await expect(page.locator(".vector-layer .road")).toHaveCount(0);
  await page.locator("#show-roads").check();
  await expect(page.locator(".vector-layer .road")).not.toHaveCount(0);
  await expect(page.locator(".explain-body")).toBeVisible();
});

test("F16: published thresholds reproduce the shipped map exactly, sliders change it", async ({ page }) => {
  await ready(page);
  await page.locator('.panel-tab[data-mode="tools"]').click();
  await page.getByRole("button", { name: "Adjust the thresholds" }).click();
  await expect(page.locator(".overlay-scientist")).toBeVisible();
  await expect(page.locator(".overlay-class")).toBeHidden();
  const readout = page.locator(".scientist-readout");
  await expect(readout).toContainText("(+0.0 vs published");
  await page.locator("#thr-fv_hh_db").fill("-2");
  await expect(readout).not.toContainText("(+0.0 vs published");
  await page.getByRole("button", { name: "Reset to published values" }).click();
  await expect(readout).toContainText("(+0.0 vs published");
  await page.getByRole("button", { name: "Back to the published map" }).click();
  await expect(page.locator(".overlay-class")).toBeVisible();
});

test("F11: every download link resolves", async ({ page, request }) => {
  await ready(page);
  // Six files of the site; a published notebook adds Colab links (notebooks.spec.js), never a local file.
  const links = page.locator('[data-feature="download"] a[download]');
  await expect(links).toHaveCount(6);
  for (const href of await links.evaluateAll((as) => as.map((a) => a.getAttribute("href")))) {
    const res = await request.get(href);
    expect(res.status(), href).toBe(200);
  }
});

test("F15: Listen toggles sound and starts the season", async ({ page }) => {
  await ready(page);
  const btn = page.getByRole("button", { name: "Listen" });
  await btn.click();
  await expect(page.getByRole("button", { name: "Stop sound" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
});

test("features hide cleanly when optional data is missing", async ({ page }) => {
  await page.route("**/data-synthetic/atchafalaya/summary.json", async (route) => {
    const res = await route.fetch();
    const s = await res.json();
    s.validation.gauge = null;
    s.validation.swot = [];
    s.validation.reference_map = null;
    s.exposure = null;
    s.products.optical = null;
    await route.fulfill({ response: res, json: s });
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await ready(page);
  await expect(page.locator('[data-feature="validation"]')).toBeHidden();
  await expect(page.locator('[data-feature="exposure"]')).toBeHidden();
  await expect(page.getByRole("button", { name: "Photo" })).toBeDisabled();
  expect(errors).toEqual([]);
});
