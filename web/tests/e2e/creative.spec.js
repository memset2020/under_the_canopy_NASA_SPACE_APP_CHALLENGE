// D-103 to D-106 on the real published data: the methane ledger, the village flood card, Earth's
// waltz with its poster, the hidden-water game and the landing page's two scales.
import { expect, test } from "@playwright/test";

const SITE = "index.html?basemap=off&site=sylhet";

test("the methane ledger shows a range, the C-band-missed part and its limits", async ({ page }) => {
  await page.goto(SITE);
  await expect(page.locator("body.is-ready")).toBeAttached();
  const card = page.locator('[data-feature="methane"]');
  await expect(card).toBeVisible();
  await expect(card.locator(".methane-big strong")).toHaveText(/^\d[\d,]*–\d[\d,]*$/);
  await expect(card).toContainText("C-band radar did not show");
  await expect(card).toContainText("not a measurement");
  await expect(card).toContainText("Bartlett");
});

test("the flood card draws a picture in Bengali with a download", async ({ page }) => {
  await page.goto(`${SITE}&lang=bn`);
  await expect(page.locator("body.is-ready")).toBeAttached();
  const card = page.locator('[data-feature="floodcard"]');
  await expect(card).toBeVisible();
  await card.locator("button.btn").first().click();
  await expect(card.locator(".floodcard-preview")).toBeVisible();
  await expect(card.locator("a[download]")).toHaveAttribute("download", /^flood-card-sylhet-2026-\d\d-\d\d\.png$/);
  const size = await card.locator(".floodcard-preview").evaluate((img) => [img.naturalWidth, img.naturalHeight]);
  expect(size).toEqual([1080, 1600]);
});

test("Earth's waltz draws one bar a pass and a poster", async ({ page }) => {
  await page.goto(SITE);
  await expect(page.locator("body.is-ready")).toBeAttached();
  const card = page.locator('[data-feature="waltz"]');
  await expect(card).toBeVisible();
  await expect(card.locator(".waltz-bar")).toHaveCount(7);
  await card.getByRole("button", { name: "Make the radar poster" }).click();
  await expect(card.locator(".waltz-poster")).toBeVisible();
  await expect(card.locator("a[download]")).toHaveAttribute("download", "earths-waltz-sylhet.png");
});

test("the game: five picks, a reveal from NISAR, a score, and on to the end", async ({ page }) => {
  await page.goto("play.html");
  await expect(page.locator(".play-cell")).toHaveCount(64);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Sylhet");
  for (const i of [9, 18, 27, 36, 45, 54]) await page.locator(".play-cell").nth(i).click();
  await expect(page.locator('.play-cell[aria-pressed="true"]')).toHaveCount(5); // the sixth is refused
  await page.getByRole("button", { name: "Reveal with NISAR radar" }).click();
  await expect(page.locator(".play-points")).toHaveText(/^\+\d+ points$/);
  expect(await page.locator(".play-cell.is-wet").count()).toBeGreaterThan(0); // Sylhet has water under trees
  await expect(page.getByRole("tab", { name: "NISAR L-band" })).toHaveAttribute("aria-selected", "true");
});

test("the landing page's two scales read their numbers from the data", async ({ page }) => {
  await page.goto("landing.html");
  await page.locator("#scales").scrollIntoViewIfNeeded();
  const planet = page.locator('[data-i18n="landing.sc_planet_d"]');
  await expect(planet).toContainText(/in \d+ flooded forests/);
  await expect(page.locator('[data-i18n="landing.sc_planet_fig"]')).toHaveText(/^[\d,]+–[\d,]+ t$/);
  await expect(page.locator("#sc-vis-planet .b-all").first()).toBeAttached();
  await expect(page.locator("#sc-vis-village canvas")).toBeAttached(); // the real flood card
  await expect(planet).not.toContainText("{");
  await expect(page.locator('[data-i18n="landing.sc_village_fig"]')).toHaveText(/^[\d,]+$/);
});

test("who it is for: six audiences, each with its reasons, its features and a start; notebooks counted from the index", async ({ page }) => {
  await page.goto("landing.html");
  const tabs = page.locator(".aud-tabs [role=tab]");
  await expect(tabs).toHaveCount(6);
  await page.locator("#aud-tab-climate").click();
  await expect(page.locator("#aud-climate")).toBeVisible();
  await expect(page.locator("#aud-resp")).toBeHidden();
  await expect(page.locator("#aud-climate .aud-fits li")).toHaveCount(3);
  await expect(page.locator("#aud-climate .aud-print li.on")).not.toHaveCount(0);
  await page.locator("#aud-tab-climate").press("ArrowDown");
  await expect(page.locator("#aud-edu")).toBeVisible();
  await page.locator("#colab").scrollIntoViewIfNeeded();
  await expect(page.locator('[data-num="nb-ice"]')).toHaveText(/^\d+$/);
  await expect(page.locator("#colab-run")).toHaveAttribute("href", /^https:\/\/colab\.research\.google\.com\/drive\/[\w-]+$/);
  await expect(page.locator("#nb-out")).toContainText("p01");
});

test("How we know: a field guide that opens on the mode's chapter, with checks and source flags", async ({ page }) => {
  await page.goto("index.html?basemap=off&site=sylhet");
  await expect(page.locator("body.is-ready")).toBeAttached();
  await page.locator(".physics-open").click();
  const dlg = page.locator(".physics-dialog");
  await expect(dlg.locator('.guide-tabs [aria-selected="true"]')).toHaveAttribute("data-chapter", "water");
  await expect(dlg.locator(".beat")).toHaveCount(5);
  await expect(dlg.locator(".decision")).toBeVisible();
  await expect(dlg.locator(".check-card").first()).toContainText("Surma");
  const flag = dlg.locator(".source-flags-list a").first();
  await expect(flag).toHaveAttribute("href", /^sources\.html#u-/);
  await dlg.locator('.guide-tabs [data-chapter="ground"]').click();
  await expect(dlg.locator(".guide-q")).toContainText("ground");
  await dlg.getByRole("button", { name: "Close" }).click();
  await page.goto("index.html?basemap=off&mode=motion");
  await expect(page.locator("body.is-ready")).toBeAttached();
  await page.locator(".physics-open").click();
  await expect(page.locator('.guide-tabs [aria-selected="true"]')).toHaveAttribute("data-chapter", "ground");
});

test("the sources page: an evidence web that filters a catalogue, a highlighted target and search", async ({ page }) => {
  await page.goto("sources.html#bartlett1988");
  await expect(page.locator(".cat-group")).toHaveCount(10);
  await expect(page.locator(".mx-row:not(.mx-head):not(.mx-foot)")).toHaveCount(10);
  await expect(page.locator("#bartlett1988")).toBeInViewport();
  await expect(page.locator("#bartlett1988 .cat-row")).toHaveAttribute("aria-expanded", "true");
  await page.locator("#src-search").fill("Seismological Society");
  await expect(page.locator(".cat-item:not([hidden])")).toHaveCount(1);
  await page.locator("#src-search").fill("");
  const cell = page.locator('.mx-cell[aria-label^="The radar × Water"]');
  await cell.click();
  await expect(cell).toHaveAttribute("aria-pressed", "true");
  const n = await page.locator("#web-detail .wd-list li").count();
  expect(n).toBeGreaterThan(0);
  await expect(page.locator(".cat-item:not([hidden])")).toHaveCount(n);
  await expect(page.locator("#u-fire")).toBeHidden();
  await page.locator(".mx-col", { hasText: "Ice" }).click();
  await expect(page.locator("#itslive")).toBeVisible();
  await page.locator("#web-detail .wd-clear").click();
  await expect(page.locator("#src-count")).toHaveText("54 of 54 sources"); // + NASA FIRMS active fire (D-138)
});
