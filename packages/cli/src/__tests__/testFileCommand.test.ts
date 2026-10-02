import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, expect, it } from "vitest";

const repositoryRoot = process.cwd();
const fixtureRoots: string[] = [];
const unit = "packages/example tests/one.test.ts";
const cli = "packages/cli-tests/cli.test.ts";
const core = "packages/core-tests/core.test.ts";
const distributed = "packages/distributed-tests/distributed.test.ts";
const performance = "packages/example tests/performance.test.ts";
const platform = "packages/example tests/platform.test.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "planweave test files "));
  fixtureRoots.push(root);
  await mkdir(join(root, "scripts"));
  await copyFile(
    join(repositoryRoot, "scripts/test-files.mjs"),
    join(root, "scripts/test-files.mjs")
  );
  const groups = [
    {
      root: "packages/example tests",
      unit: ["one.test.ts"],
      integration: [],
      performance: ["performance.test.ts"],
      platform: ["platform.test.ts"]
    },
    {
      root: "packages/cli-tests",
      unit: [],
      integration: ["cli.test.ts"],
      performance: [],
      platform: []
    },
    {
      root: "packages/core-tests",
      unit: [],
      integration: ["core.test.ts"],
      performance: [],
      platform: []
    },
    {
      root: "packages/distributed-tests",
      unit: [],
      integration: ["distributed.test.ts"],
      performance: [],
      platform: []
    }
  ];
  await writeFile(
    join(root, "vitest.suites.json"),
    JSON.stringify({
      groups,
      integrationShards: {
        cli: [groups[1].root],
        core: [groups[2].root],
        distributed: [groups[3].root]
      }
    })
  );
  for (const path of [unit, cli, core, distributed, performance, platform]) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), "");
  }
  await writeFile(
    join(root, "scripts/run-test-files.mjs"),
    `
import { appendFileSync } from "node:fs";
appendFileSync("calls.jsonl", JSON.stringify(process.argv.slice(2)) + "\\n");
`
  );
  return root;
}

function run(root: string, paths: string[]) {
  return spawnSync(process.execPath, [join(root, "scripts/test-files.mjs"), ...paths], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    shell: false
  });
}

async function calls(root: string): Promise<string[][]> {
  return (await readFile(join(root, "calls.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

it("dispatches all manifest groups sequentially with their existing worker limits", async () => {
  const root = await fixture();
  const result = run(root, [platform, distributed, cli, performance, core, unit]);
  expect(result.status, result.stderr).toBe(0);
  expect(await calls(root)).toEqual([
    ["vitest.unit.config.ts", "2", unit],
    ["vitest.integration-cli.config.ts", "2", cli],
    ["vitest.integration-core.config.ts", "2", core],
    ["vitest.integration-distributed.config.ts", "1", distributed],
    ["vitest.performance.config.ts", "1", performance],
    ["vitest.platform.config.ts", "2", platform]
  ]);
});

it("normalizes separators and absolute paths, preserves spaces, and deduplicates", async () => {
  const root = await fixture();
  const result = run(root, ["--", unit.replaceAll("/", "\\"), join(root, unit), unit]);
  expect(result.status, result.stderr).toBe(0);
  expect(await calls(root)).toEqual([["vitest.unit.config.ts", "2", unit]]);
});

it.each([
  [],
  ["--"],
  [""],
  ["packages"],
  ["../outside.test.ts"],
  ["unknown.test.ts"],
  [unit, "missing.test.ts"],
  [unit, "--maxWorkers", "1"],
  ["packages/**/*.test.ts"]
])("rejects invalid input before starting any child: %j", async (...paths: string[]) => {
  const root = await fixture();
  const result = run(root, paths);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("pnpm test:file");
  await expect(readFile(join(root, "calls.jsonl"))).rejects.toThrow();
});

it("rejects a classified directory and a symlink leaving the repository", async () => {
  const root = await fixture();
  await rm(join(root, unit));
  await mkdir(join(root, unit));
  expect(run(root, [unit]).status).toBe(1);
  await rm(join(root, unit), { recursive: true });
  await symlink(join(repositoryRoot, "package.json"), join(root, unit));
  expect(run(root, [unit]).status).toBe(1);
  await expect(readFile(join(root, "calls.jsonl"))).rejects.toThrow();
});

it.each([
  "process.exit(7);",
  'process.kill(process.pid, "SIGTERM");'
])("stops after a child failure without running later groups", async (failure) => {
  const root = await fixture();
  await writeFile(
    join(root, "scripts/run-test-files.mjs"),
    `
import { appendFileSync } from "node:fs";
appendFileSync("calls.jsonl", JSON.stringify(process.argv.slice(2)) + "\\n");
${failure}
`
  );
  const result = run(root, [unit, cli]);
  expect(result.status).toBe(failure.includes("exit") ? 7 : 1);
  expect(await calls(root)).toHaveLength(1);
});

it("runs real pnpm and Vitest with exact includes, excluding a similar filename", async () => {
  const root = await fixture();
  await copyFile(
    join(repositoryRoot, "scripts/run-test-files.mjs"),
    join(root, "scripts/run-test-files.mjs")
  );
  await symlink(join(repositoryRoot, "node_modules"), join(root, "node_modules"), "junction");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ type: "module", scripts: { "test:file": "node scripts/test-files.mjs" } })
  );
  await writeFile(
    join(root, "vitest.unit.config.ts"),
    'export default { test: { include: ["packages/**/*.test.ts"] } };'
  );
  await writeFile(
    join(root, unit),
    'import { it, expect } from "vitest"; it("exact selected file", () => expect(1).toBe(1));'
  );
  await writeFile(
    join(root, `${unit}.near.test.ts`),
    'throw new Error("SIMILAR_FILE_MUST_NOT_RUN");'
  );
  const pnpmEntry =
    process.env.npm_execpath ??
    (process.env.PATH ?? "")
      .split(delimiter)
      .flatMap((directory) => [
        join(directory, "pnpm"),
        join(directory, "node_modules/pnpm/bin/pnpm.cjs")
      ])
      .filter((candidate) => existsSync(candidate))
      .map((candidate) => realpathSync(candidate))
      .find((candidate) => /\.[cm]?js$/.test(candidate));
  if (!pnpmEntry) throw new Error("Cannot locate the installed pnpm Node entrypoint.");
  const result = spawnSync(process.execPath, [pnpmEntry, "test:file", unit], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    shell: false
  });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain("1 passed");
  expect(result.stdout).toContain("one.test.ts");
  expect(result.stdout + result.stderr).not.toContain("SIMILAR_FILE_MUST_NOT_RUN");
}, 35_000);
