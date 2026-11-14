// F37 Detailed belt: mapped cells draw on the World map when zoomed in, never on a site map (D-099);
// the World card counts them.
import { expect, test } from "@playwright/test";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
// At the World view's centre (15° E, 10° N), so zooming in on the map's centre brings it into view.
const CELL = {
  id: "cell_239_0353", bounds: [14.875, 9.875, 15.125, 10.125], passes: 8, first: "2026-06-28", last: "2026-10-02",
  peak_date: "2026-06-28", peak_flooded_km2: 40.1, peak_hidden_km2: 31.2, hidden_from_cband_km2: null,
  flooded_any_km2: 55, max_days: 96, peak_png: "cell_239_0353/peak_class.png", days_png: "cell_239_0353/days_flooded.png", warnings: [],
};

test("belt cells draw on the World map, not around a site, and the World card reports them", async ({ page }) => {
  await page.route("**/data/manifest.json", async (r) => {
    if (r.request().method() !== "GET") return r.continue();
    const res = await r.fetch();
    const m = await res.json();
    m.belt = "belt/index.json";
    await r.fulfill({ response: res, json: m });
  });
  await page.route("**/data/belt/index.json", (r) => r.fulfill({ json: { cells: [CELL] } }));
  await page.route("**/data/belt/cell_239_0353/*.png", (r) => r.fulfill({ status: 200, contentType: "image/png", body: PNG }));
  await page.goto("index.html?site=atchafalaya&basemap=off");
  await expect(page.locator("body.is-ready")).toBeAttached();
  await expect(page.locator(".overlay-belt")).toHaveCount(0); // a site map shows only the site's own data
  await page.locator(".world-btn").click();
  const card = page.locator('[data-feature="belt"]');
  await expect(card).toBeVisible();
  await expect(card).toContainText("1 flooded-forest cells mapped");
  await expect(card).toContainText("Zoom in");
  const box = await page.locator("#map").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let k = 0; k < 4; k += 1) {
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(150);
  }
  await expect(page.locator(".overlay-belt")).toHaveCount(1); // World map, zoom ≥ 7, cell in view
  await page.selectOption("#belt-show", "off");
  await expect(page.locator(".overlay-belt")).toHaveCount(0);
});
