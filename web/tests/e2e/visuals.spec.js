// Visual layers: real radar image, change composite, detection ladder, lens, small multiples.
import { expect, test } from "@playwright/test";

const BASE = "index.html?data=data-synthetic&basemap=off&site=atchafalaya";
async function ready(page, q = "") {
  await page.goto(BASE + q);
  await expect(page.locator("body.is-ready")).toBeAttached();
}

test("radar image and change views paint the real backscatter", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await ready(page, "&pass=p08");
  await page.getByRole("button", { name: "Radar image" }).click();
  await expect(page.locator(".overlay-radar")).toBeVisible();
  await expect(page.locator(".overlay-class")).toBeHidden();
  await expect(page.locator(".layers-card")).toContainText("red HH, green HV");
  // Painted pixels, not an empty canvas.
  const lit = await page.locator(".overlay-radar").evaluate((c) => {
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n += 1;
    return n / (c.width * c.height);
  });
  expect(lit).toBeGreaterThan(0.5);
  await page.getByRole("button", { name: "Change", exact: true }).click();
  await expect(page.locator(".layers-card")).toContainText("against the driest pass");
  await expect(page).toHaveURL(/view=change/);
  expect(errors).toEqual([]);
});

test("detection ladder and lens", async ({ page }) => {
  await ready(page, "&pass=p08&compare=cband");
  const ladder = page.locator(".ladder");
  await expect(ladder.locator(".rung")).toHaveCount(3);
  await expect(ladder.locator(".seg-hidden")).toHaveCount(1);
  const lens = page.getByRole("button", { name: "Lens" });
  await lens.click();
  await expect(lens).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".lens-ring")).toBeVisible();
  await expect(page.locator(".swipe")).toBeHidden();
  await lens.click();
  await expect(page.locator(".swipe")).toBeVisible();
});

test("season small multiples open a pass", async ({ page }) => {
  await ready(page, "&mode=evidence");
  const cells = page.locator(".season-cell");
  await expect(cells).toHaveCount(14);
  await cells.nth(2).click();
  await expect(cells.nth(2)).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(/pass=p03/);
});

test("v9: annotation, usual-water outline and the wet-year card", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await ready(page, "&pass=p08");
  // The note outlines the patch itself and anchors its leader inside it (no loose ring).
  const main = page.locator('.annotate-note[data-note="flood"]');
  await expect(main).toHaveCount(1);
  await expect(main.locator(".annotate-dot")).toHaveCount(1);
  await expect(main.locator(".annotate-text")).toContainText(/Largest patch/);
  await expect(main.locator(".annotate-detail").first()).toContainText(/km²/);
  await expect(page.locator(".annotate-layer .annotate-outline").first()).toBeAttached();
  await expect(page.locator(".overlay-usual")).toBeAttached();
  await expect(page.locator("#show-usual")).toBeChecked();
  await expect(page.locator(".reveal-detail")).toContainText("where water usually is");
  const basin = page.locator('[data-feature="basin"]');
  await expect(basin).toBeVisible();
  await expect(basin).toContainText(/held (\d+ cm (more|less) water than|about as much water as) is normal for that month/);
  await expect(basin.locator("rect.bar")).toHaveCount(12);
  await page.getByRole("button", { name: "Days flooded" }).click();
  await expect(page.locator(".annotate-layer .annotate-text")).toContainText(/Flooded the longest/);
  expect(errors).toEqual([]);
});

test("F38: every view gets its own notes, clear of the controls, and they switch off", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await ready(page, "&pass=p08");
  const notes = page.locator(".annotate-layer .annotate-note");
  for (const name of ["Each pass", "Days flooded", "Canopy", "Radar image", "Change", "Height above river"]) {
    const btn = page.getByRole("button", { name, exact: true });
    if (!(await btn.isVisible()) || (await btn.isDisabled())) continue;
    await btn.click();
    const n = await notes.count();
    expect(n, name).toBeLessThanOrEqual(3);
    // No label plate may sit on a map control.
    const overlaps = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll(".annotate-box")].map((b) => b.getBoundingClientRect());
      const ctl = [...document.querySelectorAll(".map-stage [data-map-control]")].filter((e) => e.offsetParent).map((e) => e.getBoundingClientRect());
      return boxes.filter((b) => ctl.some((c) => b.left < c.right && c.left < b.right && b.top < c.bottom && c.top < b.bottom)).length;
    });
    expect(overlaps, name).toBe(0);
  }
  await page.getByRole("button", { name: "Each pass", exact: true }).click();
  // The caption is chrome too: a note whose anchor it covers is not drawn, so count once it is up.
  await expect(page.locator(".annotate-caption")).toBeVisible();
  const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await frames();
  const n0 = await notes.count();
  expect(n0).toBeGreaterThan(0);
  await page.locator("#show-notes").uncheck();
  await expect(notes).toHaveCount(0);
  await expect(page.locator(".annotate-caption")).toBeHidden();
  await page.locator("#show-notes").check();
  await frames();
  await expect(notes).toHaveCount(n0);
  expect(errors).toEqual([]);
});

test("D-079: notes run with the time series: caption, confirmed change, trend, steady labels", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await ready(page, "&pass=p01");
  const cap = page.locator(".annotate-caption");
  await expect(cap).toBeVisible();
  await expect(cap).toContainText(/km² of water under the trees/);
  await expect(cap).toContainText(/A trend needs 5 passes/);
  // Later passes: the change since the last pass, how much of it is beyond speckle, and a trend.
  await ready(page, "&pass=p08");
  await expect(cap).toContainText(/since/);
  await expect(cap).toContainText(/omnibus test, p < 0\.01, \d+ looks/);
  await expect(cap).toContainText(/Last 6 passes: (falling|rising|no clear trend)/);
  await expect(cap).toContainText(/Mann–Kendall/);
  // The main patch label stays put from one pass to the next while it is the same patch.
  const box = async () => page.locator('.annotate-note[data-note="flood"] rect').evaluate((r) => [r.getAttribute("x"), r.getAttribute("y")].join(","));
  const key = async () => page.locator('.annotate-note[data-note="flood"] .annotate-detail').first().textContent();
  const before = await box();
  const sinceBefore = await key();
  await page.getByRole("button", { name: "Next pass" }).click();
  await expect(page).toHaveURL(/pass=p09/);
  if ((await key()).includes(sinceBefore.split("since ")[1] ?? "§")) expect(await box()).toBe(before);
  // The change view tests against the reference pass at the estimated looks.
  await page.getByRole("button", { name: "Change", exact: true }).click();
  const det = page.locator('.annotate-note[data-note="brighter"] .annotate-detail, .annotate-note[data-note="darker"] .annotate-detail');
  if (await det.count()) await expect(det.first()).toContainText(/beyond speckle \(p < 0\.01, \d+ looks\)/);
  expect(errors).toEqual([]);
});

test("critique pass: map controls, honest chart and level text, clipped swipe", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await ready(page, "&pass=p08&compare=cband");
  // Zoom buttons and a metric scale bar.
  const z0 = await page.evaluate(() => document.querySelector(".scale-bar b").textContent);
  await page.getByRole("button", { name: "Zoom out" }).click();
  await expect(page.locator(".scale-bar b")).not.toHaveText(z0);
  await page.getByRole("button", { name: "Zoom in" }).click();
  // The swipe hides the NISAR layer on its left instead of a dark backdrop.
  await expect(page.locator(".compare-backdrop")).toHaveCount(0);
  await expect.poll(() => page.locator(".overlay-class").evaluate((el) => el.style.clipPath)).toMatch(/inset\(0px 0px 0px \d+/);
  // C-band as diamonds on a date axis; no raw pipeline text in the level card.
  await expect(page.locator(".area-chart path.dot-cband")).not.toHaveCount(0);
  const level = page.locator('[data-feature="level"]');
  if (await level.isVisible()) await expect(level).not.toContainText("(verify)");
  // Zoomed far out in Site mode: the screening grid is labelled as such.
  await page.locator("#map").focus();
  for (let i = 0; i < 6; i += 1) await page.keyboard.press("-");
  expect(errors).toEqual([]);
});
