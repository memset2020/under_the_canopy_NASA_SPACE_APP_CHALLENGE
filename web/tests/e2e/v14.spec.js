// Contract v14 (docs/15, D-085): the fire day by day from VIIRS, a second burned-area check, and
// the icefield downwind. These run on the real data in web/data (no synthetic twin).
import { expect, test } from "@playwright/test";

const ready = async (page, query) => {
  await page.goto(`index.html?basemap=off${query}`);
  await expect(page.locator("body.is-ready")).toBeAttached();
};

test("Thunder Bay keeps MODIS as its check and adds VIIRS burned area and fire by day", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await ready(page, "&site=thunder_bay_36&mode=evidence");
  const card = page.locator('[data-feature="burn"]');
  await expect(card).toContainText("NASA MODIS burned area");
  await expect(card.locator(".burn-check-other")).toContainText("NASA VIIRS burned area"); // a row of the checklist (D-093)
  await expect(card).toContainText("east half");
  const af = card.locator(".burn-af");
  await expect(af).toBeVisible();
  await expect(af).toContainText("fire pixels");
  await expect(af.locator(".fire-bar").first()).toBeAttached();
  await expect(af.locator(".fire-pass").first()).toBeAttached();
  // The icefield card belongs to the Bald Range fire only.
  await expect(page.locator('[data-feature="ice"]')).toBeHidden();
  expect(errors).toEqual([]);
});

test("the fire pixels are off at first, show the pass's new detections when asked, and hide again", async ({ page }) => {
  // Pass 4 (23 Jul), while the fire burned: the last pass has no new detections (D-088).
  await ready(page, "&site=thunder_bay_36&mode=evidence&pass=p04");
  const painted = () =>
    page.evaluate(() => {
      const c = document.querySelector("canvas.fire-layer");
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i]) n++;
      return n;
    });
  await expect.poll(painted).toBe(0);
  await page.locator("#show-fire").check();
  // The points file is ~0.7 MB: allow for a slow load under parallel test workers.
  await expect.poll(painted, { timeout: 20_000 }).toBeGreaterThan(0);
  await page.locator("#show-fire").uncheck();
  await expect.poll(painted).toBe(0);
});

test("Bald Range is scored against VIIRS, out of sample, with the icefield downwind", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await ready(page, "&site=bald_range&mode=evidence");
  const card = page.locator('[data-feature="burn"]');
  await expect(card).toContainText("NASA VIIRS burned area");
  await expect(card).toContainText("not changed here");
  await expect(card).not.toContainText("west half of this box");
  const ice = page.locator('[data-feature="ice"]');
  await expect(ice).toBeVisible();
  await expect(ice.locator(".ice-lead")).toContainText("Columbia Icefield");
  await expect(ice).toContainText("Can NISAR see the ice move?");
  await expect(ice.locator("table.ice-speed")).toContainText("Athabasca Glacier");
  await ice.locator("button", { hasText: "Show the icefield on the map" }).click();
  await expect(page.locator(".vector-layer .glacier-outline").first()).toBeAttached();
  expect(errors).toEqual([]);
});

// Since D-087 the header's Ice opens the glacier mode (its own list and map); the smoke-and-ice
// card stays on the fire site (the test above).
test("the header's Ice choice opens the glaciers from any page", async ({ page }) => {
  await ready(page, "");
  const ice = page.locator('.changes-switch [data-kind="ice"]');
  await expect(ice).toBeVisible();
  await ice.click();
  await expect(page.locator("body")).toHaveAttribute("data-mode", "ice");
  await expect(ice).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-feature="glaciers"]')).toBeVisible();
  // Fire goes back to the burned forest on the same site.
  await page.locator('.changes-switch [data-kind="fire"]').click();
  await expect(page.locator('.changes-switch [data-kind="fire"]')).toHaveAttribute("aria-pressed", "true");
});
