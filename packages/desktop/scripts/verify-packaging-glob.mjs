import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";

const desktopRequire = createRequire(new URL("../package.json", import.meta.url));
const asarRequire = createRequire(desktopRequire.resolve("@electron/asar"));
const glob = asarRequire("glob");
const globAsync = promisify(glob);
let root;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "planweave-packaging-glob-"));
  for (const file of ["a.js", "b.ts", ".a.js", ".b.ts", "lib/c.js", "lib/.secret"]) {
    const target = join(root, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "fixture");
  }
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

const cases = [
  { pattern: ".{a,b}.*", expected: [".a.js", ".b.ts"] },
  {
    pattern: "**/{*,.*}",
    expected: [".a.js", ".b.ts", "a.js", "b.ts", "lib", "lib/.secret", "lib/c.js"]
  },
  {
    pattern: "missing*.{js,ts}",
    options: { nonull: true },
    expected: ["missing*.js", "missing*.ts"]
  },
  {
    pattern: "{*.js,*.js}",
    options: { nounique: true },
    expected: ["a.js", "a.js"]
  },
  { pattern: "lib/../*.js", expected: ["lib/../a.js"] },
  { pattern: "lib/../*.js", options: { nocase: true }, expected: [] },
  {
    pattern: "**/*.{js,ts}",
    options: { dot: true, ignore: "**/.b.*" },
    expected: [".a.js", "a.js", "b.ts", "lib/c.js"]
  },
  { pattern: "@(a|b).*", expected: ["a.js", "b.ts"] },
  { pattern: "**/*.js", options: { nodir: true }, expected: ["a.js", "lib/c.js"] },
  { pattern: "**/*.js", options: { noglobstar: true }, expected: ["lib/c.js"] },
  { pattern: " a.js ", expected: ["a.js"] }
];

if (process.platform !== "win32") {
  cases.push({ pattern: "\\a.js", expected: ["a.js"] });
}

for (const mode of ["sync", "async"]) {
  for (const { pattern, options, expected } of cases) {
    test(`${mode}: ${pattern} ${JSON.stringify(options ?? {})}`, async () => {
      const settings = { cwd: root, ...options };
      const actual =
        mode === "sync" ? glob.sync(pattern, settings) : await globAsync(pattern, settings);
      assert.deepEqual(actual.sort(), [...expected].sort());
    });
  }
}

test("brace expansion retains its safety limit", () => {
  assert.deepEqual(glob.sync("file{1..20}", { cwd: root, braceExpandMax: 4, nonull: true }), [
    "file1",
    "file2",
    "file3",
    "file4"
  ]);
});
