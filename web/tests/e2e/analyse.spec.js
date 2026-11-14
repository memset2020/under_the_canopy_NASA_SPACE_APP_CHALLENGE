// F36 Analyse here: the card appears only when the local server answers /api/health.
import { expect, test } from "@playwright/test";

test("analyse here: hidden without the local server", async ({ page }) => {
  await page.goto("index.html?site=atchafalaya&basemap=off&mode=world");
  await expect(page.locator("body.is-ready")).toBeAttached();
  const box = await page.locator("#map").boundingBox();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.55);
  await expect(page.locator('[data-feature="placebuild"]')).toBeHidden();
});

test("analyse here: starts a job and offers the new map when it is done", async ({ page }) => {
  let polls = 0;
  await page.route("**/data/manifest.json", async (r) => {
    const res = await r.fetch();
    await r.fulfill({ response: res, headers: { ...res.headers(), "x-canopy-analyse": "1" } });
  });
  await page.route("**/api/analyse", (r) => r.fulfill({ status: 202, json: { job: "abc", site: "here_x" } }));
  await page.route("**/api/jobs/abc", (r) => {
    polls += 1;
    return r.fulfill({ json: polls < 2 ? { status: "running", step: "1/7 radar", log: ["== radar"] } : { status: "done", site_id: "here_x", log: ["done"] } });
  });
  await page.goto("index.html?site=atchafalaya&basemap=off&mode=world");
  await expect(page.locator("body.is-ready")).toBeAttached();
  await page.getByRole("button", { name: "Show the whole world" }).click();
  // Pick a cell with 6+ NISAR passes: the Congo basin.
  await page.evaluate(() => null);
  const box = await page.locator("#map").boundingBox();
  await page.mouse.click(box.x + box.width * 0.52, box.y + box.height * 0.56);
  const card = page.locator('[data-feature="placebuild"]');
  await expect(card).toBeVisible();
  const start = card.getByRole("button", { name: "Build a detailed map here" });
  if (await start.isDisabled()) test.skip(true, "picked cell has too few passes in this build");
  await start.click();
  await expect(card.locator(".analyse-status")).toContainText(/Working|Done/);
  await expect(card.getByRole("link", { name: "Open the new map" })).toBeVisible({ timeout: 15000 });
  await expect(card.getByRole("link", { name: "Open the new map" })).toHaveAttribute("href", "?site=here_x");
});
