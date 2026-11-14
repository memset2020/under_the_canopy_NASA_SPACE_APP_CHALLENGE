// The notebooks published to Drive (data/notebooks.json, D-098): one per site, event and glacier,
// each carrying the published files it was built from. After a data rebuild the notebooks must be
// rebuilt and republished (notebooks/build_notebooks.py, then notebooks/sync_to_drive.py).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

const web = new URL("../../", import.meta.url);
const read = (p) => JSON.parse(readFileSync(new URL(p, web), "utf8"));
const file = new URL("data/notebooks.json", web);

test("every site, event and glacier has a published notebook", { skip: !existsSync(file) && "no notebooks.json yet" }, () => {
  const nb = read("data/notebooks.json").notebooks;
  const want = [
    ...read("data/manifest.json").sites.filter((s) => !s.synthetic).map((s) => `${s.kind === "fire" ? "fire" : "water"}/${s.id}`),
    ...read("data/motion/index.json").events.map((e) => `ground/${e.id}`),
    ...read("data/glaciers/index.json").glaciers.map((g) => `ice/${g.id}`),
  ];
  assert.deepEqual(want.filter((k) => !nb[k]), []);
  for (const k of want) assert.match(nb[k].colab, /^https:\/\/colab\.research\.google\.com\/drive\/[\w-]+$/, k);
});

test("each published notebook carries the current published data", { skip: !existsSync(file) && "no notebooks.json yet" }, () => {
  const stale = [];
  for (const [key, entry] of Object.entries(read("data/notebooks.json").notebooks)) {
    for (const [rel, sha] of Object.entries(entry.data)) {
      const now = createHash("sha256").update(readFileSync(new URL(rel.replace(/^web\//, ""), web))).digest("hex");
      if (now !== sha) stale.push(`${key}: ${rel}`);
    }
  }
  assert.deepEqual(stale, [], "rebuild and republish these notebooks");
});
