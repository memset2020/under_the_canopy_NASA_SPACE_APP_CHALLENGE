// Each place's notebook in Colab (D-098): the Download card for water and fire sites, the Ground and
// Ice cards for events and glaciers. Links out only; skipped until data/notebooks.json is published.
import { existsSync } from "node:fs";
import { expect, test } from "@playwright/test";

test.skip(!existsSync(new URL("../../data/notebooks.json", import.meta.url)), "no notebooks.json yet");
const COLAB = /^https:\/\/colab\.research\.google\.com\/drive\/[\w-]+$/;

test("a water site's Download card links its own notebook", async ({ page }) => {
  await page.goto("index.html?site=atchafalaya&mode=evidence&basemap=off");
  const link = page.locator('[data-feature="download"] a.colab-run');
  await expect(link).toHaveAttribute("href", COLAB);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(page.locator('[data-feature="download"] a.notebook-file')).toHaveCount(1);
});

test("the Ground and Ice cards link the event's and the glacier's notebook", async ({ page }) => {
  await page.goto("index.html?mode=motion&basemap=off");
  await expect(page.locator('[data-feature="motion"] .notebook-line a.colab-run')).toHaveAttribute("href", COLAB);
  await page.goto("index.html?mode=ice&basemap=off");
  await expect(page.locator('[data-feature="glaciers"] .notebook-line a.colab-run')).toHaveAttribute("href", COLAB);
});
