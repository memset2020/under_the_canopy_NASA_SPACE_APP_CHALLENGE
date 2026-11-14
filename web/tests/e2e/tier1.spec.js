// Tier 1 features on synthetic data: F02 reveal, F03 explainer, F06 physics.
import { expect, test } from "@playwright/test";

const BASE = "index.html?data=data-synthetic&basemap=off&site=atchafalaya";

async function ready(page, query = "") {
  await page.goto(BASE + query);
  await expect(page.locator("body.is-ready")).toBeAttached();
}

// Click the map at the centre of a grid cell that has the wanted class at the current pass.
async function clickClass(page, wanted) {
  const point = await page.evaluate(async (code) => {
    const { classifyPixel } = await import("./src/rules.js");
    const img = document.querySelector(".overlay-class");
    const r = img.getBoundingClientRect();
    const params = new URLSearchParams(location.search);
    const site = params.get("site");
    const summary = await (await fetch(`data-synthetic/${site}/summary.json`)).json();
    const stack = new Uint8Array(await (await fetch(`data-synthetic/${site}/stack.bin`)).arrayBuffer());
    const statics = new Uint8Array(await (await fetch(`data-synthetic/${site}/static.bin`)).arrayBuffer());
    const { width: W, height: H } = summary.grid;
    const P = summary.passes.length;
    const p = summary.passes.findIndex((x) => x.id === params.get("pass"));
    for (let row = 20; row < H - 20; row += 3) {
      for (let col = 20; col < W - 20; col += 3) {
        const i = row * W + col;
        const q = (l) => stack[(l * P + p) * W * H + i];
        const res = classifyPixel(q(0) * 0.25 - 50, q(1) * 0.25 - 50, q(2) * 0.25, statics[i], summary.thresholds);
        if (q(0) && res.cls === code && res.conf === 1) {
          return { x: r.left + ((col + 0.5) / W) * r.width, y: r.top + ((row + 0.5) / H) * r.height };
        }
      }
    }
    return null;
  }, wanted);
  expect(point).not.toBeNull();
  await page.mouse.click(point.x, point.y);
}

test("F02: C-band swipe shows the divider and a hidden-area counter", async ({ page }) => {
  await ready(page, "&pass=p08&compare=cband");
  await expect(page.locator(".swipe")).toBeVisible();
  await expect(page.locator(".overlay-compare")).toBeVisible();
  await expect(page.locator(".reveal-number")).toHaveText(/^\d+(\.\d)?$/);
  await page.locator(".swipe").focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator(".swipe")).toHaveAttribute("aria-valuenow", "45");
  await page.getByRole("button", { name: "NISAR only" }).click();
  await expect(page.locator(".swipe")).toBeHidden();
});

test("F02: a pass without C-band offers a jump to the nearest one", async ({ page, request }) => {
  const summary = await (await request.get("data-synthetic/atchafalaya/summary.json")).json();
  const unmatched = summary.passes.find((p) => p.cband_date === null);
  test.skip(!unmatched, "every pass has a C-band match in this build");
  await ready(page, `&pass=${unmatched.id}`);
  await expect(page.locator(".reveal-sentence")).toContainText("No C-band image");
  await page.getByRole("button", { name: /^Go to/ }).click();
  await expect(page).not.toHaveURL(new RegExp(`pass=${unmatched.id}`));
});

test("F03: clicking hidden flood explains the double bounce; Esc clears", async ({ page }) => {
  await ready(page, "&pass=p08");
  await clickClass(page, 3);
  await expect(page.locator(".verdict")).toHaveText("Water under the trees");
  await expect(page.locator(".verdict-reason")).toContainText("double bounce");
  await expect(page.locator(".series-chart .dot")).toHaveCount(14);
  await page.keyboard.press("Escape");
  await expect(page.locator(".explain-body")).toBeHidden();
});

test("F03: open water verdict", async ({ page }) => {
  await ready(page, "&pass=p08");
  await clickClass(page, 2);
  await expect(page.locator(".verdict")).toHaveText("Open water");
});

test("F06: How we know opens a dialog with rules from the data", async ({ page }) => {
  await ready(page);
  await page.getByRole("button", { name: "How we know" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("HH above -5.00 dB");
  await expect(dialog.locator(".physics-diagram")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
