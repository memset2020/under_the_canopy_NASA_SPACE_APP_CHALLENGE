// Every feature module must at least parse and import: a syntax error only skips its card at
// runtime (D-058), so nothing else would notice. main.js reads the page URL when it loads, so it
// is syntax-checked instead of imported.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = new URL("../../src/", import.meta.url);

test("every module in src/ parses, and every module but the bootstrap imports", async () => {
  const failed = [];
  for (const file of readdirSync(src).filter((f) => f.endsWith(".js"))) {
    try {
      if (file === "main.js") execFileSync(process.execPath, ["--check", fileURLToPath(new URL(file, src))], { stdio: "pipe" });
      else await import(new URL(file, src));
    } catch (err) {
      failed.push(`${file}: ${String(err.stderr ?? err.message).split("\n").slice(0, 3).join(" ")}`);
    }
  }
  assert.deepEqual(failed, []);
});
