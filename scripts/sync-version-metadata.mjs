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
  mcp: "packages/mcp/package.json",
  server: "packages/server/package.json"
};

const versionSourceFiles = {
  mcp: {
    path: "packages/mcp/src/packageInfo.ts",
    pattern: /export const mcpPackageVersion = "([^"]+)";/
  }
};

const readmeBadgeTargets = ["README.md", "readme/README.zh-CN.md"];

const versionFlagTargets = {
  "--root": ["root"],
  "--runtime": ["runtime"],
  "--cli": ["cli"],
  "--desktop": ["desktop"],
  "--mcp": ["mcp"],
  "--server": ["server"],
  "--npm": ["runtime", "cli"],
  "--all": ["root", "runtime", "cli", "desktop", "mcp", "server"]
};

const semverTextPattern = String.raw`(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?`;
const semverPattern = new RegExp(`^${semverTextPattern}$`);
const readmeBadgeStartMarker = "<!-- planweave-badges:start -->";
const readmeBadgeEndMarker = "<!-- planweave-badges:end -->";
const readmeVersionBadgePattern = new RegExp(
  `(img\\.shields\\.io/badge/version-)(${semverTextPattern})(-orange)`,
  "g"
);

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
    "  --server    packages/server/package.json",
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

async function syncVersionSourceFile(target, version, changedFiles) {
  const sourceFile = versionSourceFiles[target];
  if (!sourceFile) {
    return;
  }
  const currentText = await readText(sourceFile.path);
  const match = sourceFile.pattern.exec(currentText);
  if (!match) {
    invalidFiles.push(`${sourceFile.path} does not expose a supported version constant`);
    return;
  }
  if (!semverPattern.test(match[1])) {
    invalidFiles.push(`${sourceFile.path} has invalid version ${JSON.stringify(match[1])}`);
    return;
  }
  const nextText = currentText.replace(sourceFile.pattern, (text) => text.replace(match[1], version));
  await writeIfChanged(sourceFile.path, nextText, changedFiles);
}

async function syncReadmeBadgeFile(relativePath, version, changedFiles) {
  const currentText = await readText(relativePath);
  const startIndex = currentText.indexOf(readmeBadgeStartMarker);
  const endIndex = currentText.indexOf(readmeBadgeEndMarker, startIndex + readmeBadgeStartMarker.length);

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    invalidFiles.push(`${relativePath} does not contain a supported planweave-badges block`);
    return;
  }

  const blockStart = startIndex + readmeBadgeStartMarker.length;
  const beforeBlock = currentText.slice(0, blockStart);
  const badgeBlock = currentText.slice(blockStart, endIndex);
  const afterBlock = currentText.slice(endIndex);

  readmeVersionBadgePattern.lastIndex = 0;
  const matches = [...badgeBlock.matchAll(readmeVersionBadgePattern)];
  if (matches.length === 0) {
    invalidFiles.push(`${relativePath} does not contain a supported version badge`);
    return;
  }

  const nextBadgeBlock = badgeBlock.replace(
    readmeVersionBadgePattern,
    (_match, badgePrefix, _badgeVersion, badgeSuffix) => `${badgePrefix}${version}${badgeSuffix}`
  );
  await writeIfChanged(relativePath, `${beforeBlock}${nextBadgeBlock}${afterBlock}`, changedFiles);
}

const changedFiles = [];
const invalidFiles = [];
let rootPackageVersion;

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
  if (target === "root") {
    rootPackageVersion = packageJson.version;
  }
  await syncVersionSourceFile(target, nextVersion ?? packageJson.version, changedFiles);
}

if (rootPackageVersion) {
  for (const readmePath of readmeBadgeTargets) {
    await syncReadmeBadgeFile(readmePath, rootPackageVersion, changedFiles);
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
