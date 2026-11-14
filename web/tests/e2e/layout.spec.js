// Layout pass (docs/10 D-080): nothing on the map covers another control, no panel runs past the
// map, the header never scrolls sideways, and each action has one place.
import { expect, test } from "@playwright/test";

const BASE = "index.html?data=data-synthetic&basemap=off&site=atchafalaya";

// Floating things over the map that must not overlap each other.
async function overlaps(page) {
  return page.evaluate(() => {
    const stage = document.querySelector(".map-stage").getBoundingClientRect();
    const sel = [".map-ctl", ".scale-bar", ".map-attribution", ".readout", ".grid-note"];
    const boxes = sel
      .flatMap((q) => [...document.querySelectorAll(q)])
      .filter((el) => el.offsetParent !== null && getComputedStyle(el).display !== "none" && !el.hidden)
      .map((el) => ({ n: el.className || el.dataset.feature, b: el.getBoundingClientRect() }));
    const out = [];
    for (let i = 0; i < boxes.length; i++) {
      const a = boxes[i].b;
      if (a.bottom > stage.bottom + 1 || a.right > stage.right + 1) out.push(`${boxes[i].n} leaves the map`);
      for (let j = i + 1; j < boxes.length; j++) {
        const b = boxes[j].b;
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (w > 2 && h > 2) out.push(`${boxes[i].n} × ${boxes[j].n}`);
      }
    }
    return out;
  });
}

for (const [name, viewport] of [["laptop", { width: 1280, height: 720 }], ["tablet", { width: 1024, height: 768 }], ["phone", { width: 390, height: 844 }]]) {
  test(`${name}: map controls do not overlap and the header does not scroll sideways`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto(BASE);
    await expect(page.locator("body.is-ready")).toBeAttached();
    await page.waitForTimeout(400);
    expect(await overlaps(page)).toEqual([]);
    // The pass caption lives in the bar under the map, never over the data.
    await expect(page.locator(".map-stage .annotate-caption")).toHaveCount(0);
    const header = await page.locator(".topbar").evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
    expect(header.sw).toBeLessThanOrEqual(header.cw + 1);
    // The map panel sits beside the map, never over it: open on a laptop, folded to its icons on
    // a tablet, a closed sheet on a phone (D-092).
    if (name === "laptop") await expect(page.locator("body")).not.toHaveClass(/dock-folded/);
    if (name === "tablet") await expect(page.locator("body")).toHaveClass(/dock-folded/);
    if (name === "phone") await expect(page.locator("#dock")).toBeHidden();
  });
}

// The bar can grow with its content, so its own scrollWidth misses an overflow: the page must not
// be wider than the window and every header control must be inside it, in every language (D-094:
// two new header chips once pushed four controls off-screen from 1180 to 1600 px).
for (const lang of ["en", "pt", "bn"]) {
  test(`header controls stay on screen at every width (${lang})`, async ({ page }) => {
    for (const width of [390, 1024, 1180, 1366, 1600, 1920]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`${BASE}&lang=${lang}`);
      await expect(page.locator("body.is-ready")).toBeAttached();
      const off = await page.evaluate(() => {
        const out = [];
        if (document.documentElement.scrollWidth > innerWidth + 1) out.push(`page ${document.documentElement.scrollWidth}px`);
        for (const el of document.querySelectorAll(".topbar button, .topbar select, .topbar a, .topbar .prov-chip")) {
          if (!el.offsetParent) continue;
          const r = el.getBoundingClientRect();
          if (r.right > innerWidth + 1 || r.left < -1) out.push(el.id || el.className || el.textContent.trim());
        }
        return out;
      });
      expect(off, `${width}px`).toEqual([]);
    }
  });
}

test("the map panel folds to its icons and opens, and remembers the choice", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(BASE);
  await expect(page.locator("body.is-ready")).toBeAttached();
  // The Layer heading names the view on the map.
  await expect(page.locator("#dock-h-layer")).toContainText("Each pass");
  const fold = page.locator(".dock-fold");
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  await fold.click();
  await expect(page.locator("body")).toHaveClass(/dock-folded/);
  await expect(page.locator('.layers-card [data-view="hydroperiod"]')).toBeHidden();
  await page.reload();
  await expect(page.locator("body.is-ready")).toBeAttached();
  await expect(page.locator(".dock-fold")).toHaveAttribute("aria-expanded", "false");
  // An icon opens the panel at its section.
  await page.locator("#dock-h-layer").click();
  await expect(page.locator("body")).not.toHaveClass(/dock-folded/);
  await expect(page.locator('.layers-card [data-view="hydroperiod"]')).toBeVisible();
});

test("one place per kind of choice: every map control is in the map panel, in the same order", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(BASE);
  await expect(page.locator("body.is-ready")).toBeAttached();
  const order = await page.locator(".dock-sec:not([hidden])").evaluateAll((els) => els.map((e) => e.dataset.sec));
  // Offline (basemap=off) there is no basemap to choose, so that section stays away.
  expect(order).toEqual(["layer", "overlays", "compare"]);
  for (const id of ["#show-usual", "#show-notes", "#orbit-nisar", "#orbit-other", "#show-roads", "#basemap-select"]) {
    await expect(page.locator(`#dock ${id}`)).toBeAttached();
  }
  await expect(page.locator('#dock [data-mode="cband"]')).toBeAttached();
  // Nothing about the map is left over the map or in the findings.
  await expect(page.locator(".map-stage select")).toHaveCount(0);
  await expect(page.locator(".sidebar #show-roads, .sidebar #orbit-nisar, .sidebar .compare-controls")).toHaveCount(0);
});

test("each action has one place: Story in the header on desktop, in the bottom bar on a phone", async ({ page }) => {
  await page.goto(BASE);
  await expect(page.locator("body.is-ready")).toBeAttached();
  await expect(page.locator(".story-open")).toBeVisible();
  await expect(page.locator('.phone-nav [data-action="story"]')).toBeHidden();
  await expect(page.locator(".map-slot-bottom .listen-btn")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".story-open")).toBeHidden();
  await expect(page.locator('.phone-nav [data-action="story"]')).toBeVisible();
  // The map panel opens as a sheet from the bottom bar, and closes again.
  await page.locator('.phone-nav [data-action="dock"]').click();
  await expect(page.locator(".layers-card [data-view=\"flood\"]")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#dock")).toBeHidden();
  // Names survive where the labels fold away.
  await expect(page.getByRole("button", { name: "How we know" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy link" })).toBeVisible();
});

// D-099: the site box stays inside the map once the bar under it fills in (the map frames the site
// before that bar has its height), and a world-only layer (the belt) never draws on a site map.
// Everglades at 1536 × 745 CSS px and 125 % scaling was clipped before the fix.
test("a framed site stays inside the map as the panels around it settle", async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 745 });
  for (const site of ["everglades", "hot_s9p62_w50p12", "janauaca"]) {
    await page.goto(`index.html?site=${site}&basemap=off`);
    await expect(page.locator("body.is-ready")).toBeAttached();
    for (const view of [null, "Change", "Days flooded"]) {
      if (view) await page.getByRole("button", { name: view, exact: true }).first().click();
      await page.waitForTimeout(400);
      const out = await page.evaluate(() => {
        const map = document.getElementById("map");
        const m = map.getBoundingClientRect();
        const el = [...map.querySelectorAll(".overlay-class, .overlay-radar, .overlay-hydro")].find((e) => e.getBoundingClientRect().width > 0);
        const b = el.getBoundingClientRect();
        return { clipped: Math.max(m.top - b.top, b.bottom - m.bottom, m.left - b.left, b.right - m.right), belt: map.querySelectorAll(".overlay-belt").length };
      });
      expect(out.clipped, `${site} ${view ?? "on load"}`).toBeLessThanOrEqual(0.5);
      expect(out.belt, `${site}: belt cells drawn on a site map`).toBe(0);
    }
  }
});

// The site box stays whole (D-099): framed before the bar under the map filled in, a tall box lost its
// top and bottom; the World mode's belt cells, drawn around a site, looked like its map spilling out.
for (const [w, h] of [[1366, 657], [1536, 745]]) {
  test(`a site's box stays inside the map after the page settles (${w}×${h})`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await page.goto("index.html?data=data-synthetic&basemap=off&site=atchafalaya");
    await expect(page.locator("body.is-ready")).toBeAttached();
    await page.waitForTimeout(600);
    for (const view of ["Each pass", "Days flooded", "Each pass"]) {
      await page.getByRole("button", { name: view, exact: true }).first().click();
      await page.waitForTimeout(300);
      const out = await page.evaluate(() => {
        const map = document.getElementById("map").getBoundingClientRect();
        const box = [...document.querySelectorAll("#map .overlay-class, #map .overlay-hydro")].find((e) => e.getBoundingClientRect().width > 0)?.getBoundingClientRect();
        return box ? Math.max(map.top - box.top, box.bottom - map.bottom, map.left - box.left, box.right - map.right) : null;
      });
      expect(out, view).not.toBeNull();
      expect(out, view).toBeLessThanOrEqual(0);
    }
    await expect(page.locator("#map .overlay-belt")).toHaveCount(0);
  });
}

// Janauacá's west third is outside track 140's swath; every pass is filled there from a neighbouring
// track (D-101): nothing is left blank, the seam is drawn, the key and the spot readout name the track.
test("a swath gap is filled from a neighbouring track and says so", async ({ page }) => {
  await page.goto("index.html?basemap=off&site=janauaca");
  await expect(page.locator("body.is-ready")).toBeAttached();
  for (const view of ["Each pass", "Days flooded"]) {
    await page.getByRole("button", { name: view, exact: true }).first().click();
    await expect(page.locator("#map .overlay-nodata")).toBeHidden();
    await expect(page.locator("#map .overlay-fill")).toBeVisible();
  }
  await expect(page.locator(".legend-fill")).toContainText("track 68, 132");
  await page.getByRole("button", { name: "Each pass", exact: true }).first().click();
  await expect(page.locator(".legend-fill")).toContainText("track 68");
  const box = await page.locator("#map .overlay-class").boundingBox();
  await page.mouse.click(box.x + box.width * 0.08, box.y + box.height * 0.5);
  await expect(page.getByText("outside track 140's swath")).toBeVisible();
});
