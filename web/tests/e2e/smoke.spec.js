// Smoke test on synthetic data (docs/08). Basemap off: no network during tests.
import { expect, test } from "@playwright/test";

const BASE = "index.html?data=data-synthetic&basemap=off";

function collectErrors(page) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  return errors;
}

test("loads a site, shows the SYNTHETIC badge and the flood overlay", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto(BASE);
  await expect(page.locator("body.is-ready")).toBeAttached();
  await expect(page.locator("#synthetic-badge")).toBeVisible();
  await expect(page.locator("#synthetic-badge")).toContainText("SYNTHETIC");
  const overlay = page.locator(".overlay-class");
  await expect(overlay).toBeVisible();
  await expect.poll(() => overlay.evaluate((img) => img.naturalWidth)).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test("deep link selects site, pass and view", async ({ page }) => {
  await page.goto(`${BASE}&site=sylhet&pass=p03&view=hydroperiod`);
  await expect(page.locator("body.is-ready")).toBeAttached();
  await expect(page.locator("#site-select")).toHaveValue("sylhet");
  await expect(page.locator(".overlay-hydro")).toBeVisible();
  await expect(page.locator(".overlay-class")).toBeHidden();
  await expect(page.getByRole("slider", { name: "Radar pass date" })).toHaveValue("2");
});

test("timeline steps passes and updates the URL", async ({ page }) => {
  await page.goto(`${BASE}&site=atchafalaya&pass=p01`);
  await expect(page.locator("body.is-ready")).toBeAttached();
  await page.getByRole("button", { name: "Next pass" }).click();
  await expect(page).toHaveURL(/pass=p02/);
});

test("switching sites keeps working", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto(BASE);
  await expect(page.locator("body.is-ready")).toBeAttached();
  for (const id of ["sylhet", "janauaca", "atchafalaya"]) {
    await page.locator("#site-select").selectOption(id);
    await expect(page).toHaveURL(new RegExp(`site=${id}`));
  }
  expect(errors).toEqual([]);
});

test("a blocked feature module is skipped, the app still starts (D-058)", async ({ page }) => {
  await page.route("**/src/share.js", (r) => r.abort("blockedbyclient"));
  await page.goto(`${BASE}&site=sylhet`);
  await expect(page.locator("body.is-ready")).toBeAttached();
  await expect(page.locator(".wordmark")).toHaveText("Under the Canopy");
  await expect(page.locator('[data-feature="compare"]')).toBeVisible();
  await expect(page.locator('[data-feature="share"]')).toHaveCount(0);
});
