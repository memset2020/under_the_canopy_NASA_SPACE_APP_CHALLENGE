// Contract v11 views on real data: floods reported now, the outlook, terrain (HAND), GLWD.
import { expect, test } from "@playwright/test";

const real = async (page, query) => {
  await page.goto(`index.html?basemap=off${query}`);
  await expect(page.locator("body.is-ready")).toBeAttached();
};

test("world mode lists floods reported now and rings them on the map", async ({ page }) => {
  await real(page, "&site=sylhet&mode=world");
  const card = page.locator('[data-feature="events"]');
  await expect(card).toBeVisible();
  await expect(card.locator(".events-lead")).toContainText(/flood events in the last \d+ days/);
  await expect(card.locator(".event-item").first()).toBeVisible();
  await expect.poll(() => page.locator(".events-layer circle").count()).toBeGreaterThan(0);
  await page.locator("#events-show").uncheck();
  await expect(page.locator(".events-layer circle")).toHaveCount(0);
});

test("Janauacá: outlook projected within the season's flows; terrain view and checks", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await real(page, "&site=janauaca");
  const o = page.locator('[data-feature="outlook"]');
  await expect(o).toBeVisible();
  await expect(o.locator(".outlook-lead")).toContainText(/km² by|almost no water|no outlook|leaves the range/i);
  await expect(o.locator("circle.outlook-pass").first()).toBeAttached();
  await page.getByRole("button", { name: "Height above river" }).click();
  await expect(page.locator(".overlay-hand")).toBeVisible();
  await expect(page.locator(".legend")).toContainText("ASF HAND");
  await expect(page.locator(".hand-line")).toContainText("Terrain check (ASF HAND)");
  await expect(page.locator(".glwd-line")).toContainText("GLWD v2");
  // This spot gives the height above the nearest drainage and the GLWD group.
  const box = await page.locator("#map").boundingBox();
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.55);
  await expect(page.locator('[data-feature="explain"]')).toContainText("Height above the nearest stream or river");
  expect(errors).toEqual([]);
});
