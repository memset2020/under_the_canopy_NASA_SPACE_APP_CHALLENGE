// F31 Anywhere on Earth, on the committed real build (web/data/global).
import { expect, test } from "@playwright/test";

test("clicking outside the detailed maps reads the global cell", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("index.html?site=atchafalaya&basemap=off");
  await expect(page.locator("body.is-ready")).toBeAttached();
  const card = page.locator('[data-feature="globe"]');
  await expect(card).toBeHidden(); // site mode
  await page.locator(".world-btn").click(); // the header's world view (D-092)
  await expect(card).toBeVisible();
  await expect(page).toHaveURL(/mode=world/);
  await expect(page.locator(".overlay-global")).toBeAttached();
  await page.getByRole("button", { name: "Show the whole world" }).click();
  const box = await page.locator("#map").boundingBox();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.55);
  await expect(card.locator(".globe-cell-title")).toContainText("Cell at");
  await expect(card.locator(".globe-facts li")).not.toHaveCount(0);
  await expect(card.locator(".globe-nearest")).toContainText("Nearest detailed L-band map");
  await page.selectOption("#globe-layer", "nisar_passes");
  await expect(page.locator(".globe-legend")).toContainText("NISAR"); // the key, under Layer in the map panel
  await page.selectOption("#globe-layer", "off");
  await expect(page.locator(".overlay-global")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("the globe card and World mode hide when a build has no global grid", async ({ page }) => {
  await page.goto("index.html?data=data-synthetic&basemap=off&site=atchafalaya");
  await expect(page.locator("body.is-ready")).toBeAttached();
  await expect(page.locator('[data-feature="globe"]')).toBeHidden();
  await expect(page.locator(".world-btn")).toBeHidden();
});

test("the tabs over the findings show one job at a time and keep it in the link", async ({ page }) => {
  await page.goto("index.html?data=data-synthetic&basemap=off&site=atchafalaya");
  await expect(page.locator("body.is-ready")).toBeAttached();
  await expect(page.locator('[data-feature="compare"]')).toBeVisible();
  await expect(page.locator('[data-feature="download"]')).toBeHidden();
  await page.locator('.panel-tab[data-mode="evidence"]').click();
  await expect(page.locator('.panel-tab[data-mode="evidence"]')).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-feature="download"]')).toBeVisible();
  await expect(page.locator('[data-feature="validation"]')).toBeVisible();
  await expect(page.locator('[data-feature="compare"]')).toBeHidden();
  await expect(page).toHaveURL(/mode=evidence/);
  await page.reload();
  await expect(page.locator('[data-feature="download"]')).toBeVisible();
  await expect(page.locator("#synthetic-badge")).toBeVisible(); // rule 3, in every mode
  await expect(page.locator("#provenance-chip")).toBeHidden();
});

test("the world map opens on forest and water together, with a 3 × 3 key", async ({ page }) => {
  await page.goto("index.html?site=atchafalaya&basemap=off&mode=world");
  await expect(page.locator("body.is-ready")).toBeAttached();
  await expect(page.locator("#globe-layer")).toHaveValue("bivariate");
  await expect(page.locator(".biv-cell")).toHaveCount(9);
  await expect(page.locator(".overlay-global")).toBeVisible();
  await page.locator(".world-btn").click(); // pressed again: back to the site
  await expect(page.locator(".overlay-global")).toBeHidden();
});

test("F41: the crosshair reads any place, In view sums the screen, leaving a site offers World", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("index.html?site=atchafalaya&basemap=off");
  await expect(page.locator("body.is-ready")).toBeAttached();
  await expect(page.locator(".readout")).toBeHidden(); // centre is inside the site map
  // Pan far away in Site mode: the chip appears and the world grid shows once zoomed out.
  await page.locator("#map").focus();
  for (let i = 0; i < 6; i += 1) await page.keyboard.press("-");
  for (let i = 0; i < 8; i += 1) await page.keyboard.press("ArrowRight");
  await expect(page.locator(".away-chip")).toBeVisible();
  await expect(page.locator(".away-chip")).toContainText("You have left the Atchafalaya Basin map");
  await expect(page.locator("body")).toHaveClass(/is-regional/);
  await expect(page.locator(".overlay-global")).toBeVisible();
  await expect(page.locator(".readout")).toBeVisible();
  await expect(page.locator(".readout-title")).toContainText("Under the crosshair");
  await page.locator(".away-chip").getByRole("button", { name: "Read this area in World mode" }).click();
  await expect(page).toHaveURL(/mode=world/);
  const inView = page.locator('[data-feature="here"]');
  await expect(inView).toBeVisible();
  await expect(inView.locator(".here-summary")).toContainText(/km² of forest in view|Mostly sea/);
  await page.selectOption("#globe-layer", "wettest_month");
  await expect(page.locator(".month-cell")).toHaveCount(12);
  await page.selectOption("#globe-layer", "water_storage_cm");
  await expect(page.locator(".ramp-storage")).toBeVisible();
  await expect(page.locator(".readout")).toContainText("Groundwater");
  // GRACE-DA model percentiles: a 0–100 key and a legend that names the week and the model.
  await page.selectOption("#globe-layer", "groundwater_pctile");
  await expect(page.locator(".globe-legend .ramp-labels")).toContainText("100");
  await expect(page.locator(".globe-legend")).toContainText("percentile of the model's 1948–2014 record");
  await expect(page.locator(".globe-legend")).toContainText("A model that assimilates GRACE-FO");
  expect(errors).toEqual([]);
});
