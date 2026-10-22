import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const script = resolve("scripts/check-source-import-paths.mjs");
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.each([
  ['import { value } from "./Domain/Value.js";', 0],
  ['export { value } from "./Domain/value.js";', 1],
  ['const value = import("./domain/Value.js");', 1],
  ['import type { Value } from "./Domain/value.js";', 1],
  ['import { value } from "./Domain/Value";', 0],
  ["const text = 'import \"./domain/value.js\"';", 0]
])("checks real relative imports case-sensitively: %s", async (source, expectedStatus) => {
  const root = await mkdtemp(join(tmpdir(), "planweave-import-casing-"));
  roots.push(root);
  await mkdir(join(root, "Domain"));
  await writeFile(
    join(root, "Domain/Value.ts"),
    "export const value = 1; export type Value = number;"
  );
  await writeFile(join(root, "index.ts"), source);
  const git = spawnSync("git", ["init", "--quiet"], { cwd: root, encoding: "utf8" });
  expect(git.status).toBe(0);
  // Untracked source must be checked before the first commit as well.
  const result = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(expectedStatus);
  if (expectedStatus === 1) {
    expect(result.stderr).toContain("import path casing mismatch");
    expect(result.stderr).toContain("Domain/Value.ts");
  }
});
