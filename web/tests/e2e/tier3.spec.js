// Tier 3: F09 story, F19 share + spot deep link, F14 languages.
import { expect, test } from "@playwright/test";

const BASE = "index.html?data=data-synthetic&basemap=off&site=atchafalaya";

async function ready(page, query = "") {
  await page.goto(BASE + query);
  await expect(page.locator("body.is-ready")).toBeAttached();
}

test("F09: the story walks the demo path with numbers from the data", async ({ page }) => {
  await ready(page);
  await page.getByRole("button", { name: "Tell me the story" }).click();
  const card = page.getByRole("region", { name: "Guided story" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("1 · See it");
  await expect(card).toContainText(/A camera photo from .* sees clouds/);
  await expect(page).toHaveURL(/compare=optical/);
  await card.getByRole("button", { name: "Next" }).click();
  await expect(page).toHaveURL(/compare=cband/);
  await card.getByRole("button", { name: "Next" }).click();
  await expect(card).toContainText(/hidden under the canopy|found [\d.,]+ km² of water/);
  await card.getByRole("button", { name: "Next" }).click();
  await expect(card).toContainText("2 · Measure it");
  await expect(page).toHaveURL(/view=hydroperiod/);
  for (let i = 0; i < 6; i += 1) {
    const btn = card.getByRole("button", { name: /^(Next|Finish)$/ });
    if (!(await card.isVisible())) break;
    if ((await btn.textContent()) === "Finish") {
      await expect(card).toContainText("3 · Trust it");
      await btn.click();
      break;
    }
    await btn.click();
  }
  await expect(card).toBeHidden();
});

test("F09: Escape closes the story", async ({ page }) => {
  await ready(page);
  await page.getByRole("button", { name: "Tell me the story" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("region", { name: "Guided story" })).toBeHidden();
});

test("F19: a shared link reopens the same spot", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await ready(page, "&pass=p08&px=120,96");
  await expect(page.locator(".explain-body")).toBeVisible();
  await page.getByRole("button", { name: "Copy link" }).click();
  await expect(page.getByRole("button", { name: "Link copied" })).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("px=120%2C96");
  await page.getByRole("button", { name: "Clear this spot" }).click();
  await expect(page).not.toHaveURL(/px=/);
});

for (const [code, title, badge] of [
  ["pt", "O que o radar revela", "SINTÉTICO"],
  ["bn", "রাডার যা দেখায়", "কৃত্রিম ডেটা"],
]) {
  test(`F14: ${code} interface, with the draft-translation note and the badge kept`, async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await ready(page, `&lang=${code}`);
    await expect(page.locator("html")).toHaveAttribute("lang", code);
    await expect(page.locator('[data-feature="compare"] h2')).toHaveText(title);
    await expect(page.locator("#synthetic-badge")).toContainText(badge);
    await expect(page.locator(".lang-note")).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test("F14: switching language keeps the view", async ({ page }) => {
  await ready(page, "&pass=p05&view=hydroperiod");
  await page.locator("#lang-select").selectOption("pt");
  await expect(page).toHaveURL(/lang=pt/);
  await expect(page).toHaveURL(/pass=p05/);
  await expect(page.locator("body.is-ready")).toBeAttached();
  await expect(page.locator(".overlay-hydro")).toBeVisible();
});

test("label mode: label a spot, persist it, download JSON for calibration", async ({ page }) => {
  await ready(page, "&pass=p05&px=100,120&mode=tools");
  const sec = page.locator('[data-feature="labels"]');
  await sec.getByRole("button", { name: "Start labelling" }).click();
  await sec.getByRole("button", { name: "Flooded vegetation" }).click();
  await expect(sec.locator(".labels-summary")).toContainText("1 labels");
  await page.reload();
  await expect(page.locator("body.is-ready")).toBeAttached();
  await sec.getByRole("button", { name: "Start labelling" }).click();
  await expect(sec.locator(".labels-summary")).toContainText("1 labels");
  const [dl] = await Promise.all([page.waitForEvent("download"), sec.getByRole("button", { name: "Download labels" }).click()]);
  const body = JSON.parse(await (await dl.createReadStream()).toArray().then((c) => Buffer.concat(c).toString()));
  expect(body.site).toBe("atchafalaya");
  expect(body.labels[0]).toMatchObject({ pass_id: "p05", row: 100, col: 120, label: "flooded_veg" });
});
