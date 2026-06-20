#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const args = process.argv.slice(2);

const packages = {
  root: "package.json",
  runtime: "packages/runtime/package.json",
  cli: "packages/cli/package.json",
  desktop: "packages/desktop/package.json",
  mcp: "packages/mcp/package.json"
};

const versionFlagTargets = {
  "--root": ["root"],
  "--runtime": ["runtime"],
  "--cli": ["cli"],
  "--desktop": ["desktop"],
  "--mcp": ["mcp"],
  "--npm": ["runtime", "cli"],
  "--all": ["root", "runtime", "cli", "desktop", "mcp"]
};

const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function usage() {
  return [
    "Usage:",
    "  pnpm sync:versions -- --desktop 0.1.5",
    "  pnpm sync:versions -- --npm 0.1.5",
    "  pnpm sync:versions -- --runtime 0.1.5 --cli 0.1.6",
    "  pnpm sync:versions -- --all 0.1.5",
    "  pnpm check:versions",
    "",
    "Version targets:",
    "  --root      package.json",
    "  --runtime   packages/runtime/package.json",
    "  --cli       packages/cli/package.json",
    "  --desktop   packages/desktop/package.json",
    "  --mcp       packages/mcp/package.json",
    "  --npm       packages/runtime/package.json and packages/cli/package.json",
    "  --all       all package.json files above"
  ].join("\n");
}

function parseArgs(argv) {
  const updates = new Map();
  let checkOnly = false;
  let printHelp = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--check") {
      checkOnly = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp = true;
      continue;
    }

    const [flag, inlineValue] = arg.includes("=") ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    const targets = versionFlagTargets[flag];
    if (!targets) {
      throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
    }

    const version = inlineValue ?? argv[index + 1];
    if (!version || version.startsWith("--")) {
      throw new Error(`Missing version for ${flag}.\n\n${usage()}`);
    }
    if (inlineValue === undefined) {
      index += 1;
    }
    if (!semverPattern.test(version)) {
      throw new Error(`Invalid semver version for ${flag}: ${version}`);
    }

    for (const target of targets) {
      updates.set(target, version);
    }
  }

  return { checkOnly, printHelp, updates };
}

const { checkOnly, printHelp, updates } = parseArgs(args);

if (printHelp) {
  console.log(usage());
  process.exit(0);
}

async function readText(relativePath) {
  return readFile(join(repoRoot, relativePath), "utf8");
}

async function readJson(relativePath) {
  return JSON.parse(await readText(relativePath));
}

function stringifyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeIfChanged(relativePath, nextText, changedFiles) {
  const currentText = await readText(relativePath);
  if (currentText === nextText) {
    return;
  }
  changedFiles.push(relativePath);
  if (!checkOnly) {
    await writeFile(join(repoRoot, relativePath), nextText, "utf8");
  }
}

const changedFiles = [];
const invalidFiles = [];

for (const [target, packageJsonPath] of Object.entries(packages)) {
  const packageJson = await readJson(packageJsonPath);
  if (!semverPattern.test(packageJson.version)) {
    invalidFiles.push(`${packageJsonPath} has invalid version ${JSON.stringify(packageJson.version)}`);
    continue;
  }

  const nextVersion = updates.get(target);
  if (nextVersion && packageJson.version !== nextVersion) {
    packageJson.version = nextVersion;
    await writeIfChanged(packageJsonPath, stringifyJson(packageJson), changedFiles);
  }
}

if (invalidFiles.length > 0) {
  console.error(`Version metadata is invalid:\n${invalidFiles.map((file) => `- ${file}`).join("\n")}`);
  process.exit(1);
}

if (changedFiles.length > 0) {
  const message = `Version metadata is out of sync:\n${changedFiles.map((file) => `- ${file}`).join("\n")}`;
  if (checkOnly) {
    console.error(message);
    console.error("Run `pnpm sync:versions -- --<target> <version>` to update package versions.");
    process.exit(1);
  }
  console.log(`Updated version metadata:\n${changedFiles.map((file) => `- ${file}`).join("\n")}`);
} else if (!checkOnly && updates.size === 0) {
  console.log("No version updates requested.");
}
