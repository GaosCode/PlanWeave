import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const usage =
  "Usage: pnpm test:file <test-file> [<test-file> ...] (exact paths; no filters or flags)";
const suites = [
  ["unit", "vitest.unit.config.ts", 2],
  ["integration-cli", "vitest.integration-cli.config.ts", 2],
  ["integration-core", "vitest.integration-core.config.ts", 2],
  ["integration-distributed", "vitest.integration-distributed.config.ts", 1],
  ["performance", "vitest.performance.config.ts", 1],
  ["platform", "vitest.platform.config.ts", 2]
];

function selectFiles(args) {
  const paths = args[0] === "--" ? args.slice(1) : args;
  if (!paths.length) throw new Error("At least one test file is required.");
  const manifest = JSON.parse(readFileSync(resolve(root, "vitest.suites.json"), "utf8"));
  const membership = new Map();
  for (const group of manifest.groups) {
    for (const suite of ["unit", "integration", "performance", "platform"]) {
      for (const name of group[suite]) {
        const file = `${group.root}/${name}`;
        let target = suite;
        if (suite === "integration") {
          const shards = Object.entries(manifest.integrationShards).filter(([, roots]) =>
            roots.includes(group.root)
          );
          if (shards.length !== 1) throw new Error(`Invalid integration shard for ${file}`);
          target = `integration-${shards[0][0]}`;
        }
        if (!suites.some(([name]) => name === target)) throw new Error(`Unknown suite for ${file}`);
        if (membership.has(file)) throw new Error(`Duplicate classification for ${file}`);
        membership.set(file, target);
      }
    }
  }
  const selected = new Map();
  const realRoot = realpathSync(root);
  for (const input of paths) {
    if (!input.trim() || input.startsWith("-")) throw new Error(`Invalid test path: ${input}`);
    const absolute = resolve(root, input.replaceAll("\\", "/"));
    const realFile = relative(realRoot, realpathSync(absolute));
    if (realFile === ".." || realFile.startsWith(`..${sep}`) || isAbsolute(realFile)) {
      throw new Error(`Outside-project test path: ${input}`);
    }
    const lexicalFile = relative(root, absolute);
    const file = (
      lexicalFile.startsWith(`..${sep}`) || isAbsolute(lexicalFile) ? realFile : lexicalFile
    )
      .split(sep)
      .join("/");
    const suite = membership.get(file);
    if (!suite) throw new Error(`Unclassified test path: ${input}`);
    if (!statSync(absolute).isFile()) throw new Error(`Not a test file: ${input}`);
    if (!selected.has(suite)) selected.set(suite, new Set());
    selected.get(suite).add(file);
  }
  return selected;
}

try {
  const selected = selectFiles(process.argv.slice(2));
  for (const [suite, config, maxWorkers] of suites) {
    const files = selected.get(suite);
    if (!files) continue;
    console.log(`test:file ${suite} (maxWorkers=${maxWorkers}):\n${[...files].join("\n")}`);
    const child = spawnSync(
      process.execPath,
      [resolve(root, "scripts/run-test-files.mjs"), config, String(maxWorkers), ...files],
      { cwd: root, stdio: "inherit", shell: false }
    );
    if (child.error) throw child.error;
    if (child.signal) {
      console.error(`test:file ${suite} terminated by ${child.signal}`);
      process.exitCode = 1;
      break;
    }
    if (child.status !== 0) {
      process.exitCode = child.status ?? 1;
      break;
    }
  }
} catch (error) {
  console.error(error.message);
  console.error(usage);
  process.exitCode = 1;
}
