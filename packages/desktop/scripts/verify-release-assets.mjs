#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));

const releaseMatrix = [
  { platform: "linux", target: "AppImage", os: "linux", arch: "x86_64", ext: "AppImage", artifact: "default" },
  { platform: "linux", target: "deb", os: "linux", arch: "amd64", ext: "deb", artifact: "default" },
  { platform: "linux", target: "tar.gz", os: "linux", arch: "x64", ext: "tar.gz", artifact: "default" },
  { platform: "mac", target: "dmg", os: "mac", arch: "universal", ext: "dmg", artifact: "dmg" },
  { platform: "mac", target: "zip", os: "mac", arch: "universal", ext: "zip", artifact: "default" },
  { platform: "win", target: "nsis", os: "win", arch: "x64", ext: "exe", artifact: "default" },
  { platform: "win", target: "zip", os: "win", arch: "x64", ext: "zip", artifact: "default" }
];

const updateMetadataAssets = ["latest-linux.yml", "latest-mac.yml", "latest.yml"];

function assertRecord(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${name} to be an object.`);
  }
  return value;
}

function readString(record, key, name) {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected ${name}.${key} to be a non-empty string.`);
  }
  return value;
}

function readStringArray(record, key, name) {
  const value = record[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new Error(`Expected ${name}.${key} to be an array of target names.`);
  }
  return value;
}

function assertTarget(targets, platform, target) {
  if (!targets[platform].includes(target)) {
    throw new Error(`Desktop electron-builder config is missing ${platform} target ${target}.`);
  }
}

export async function loadDesktopBuildConfig(path = packageJsonPath) {
  const packageJson = assertRecord(JSON.parse(await readFile(path, "utf8")), "packages/desktop/package.json");
  const build = assertRecord(packageJson.build, "packages/desktop/package.json build");
  const dmg = assertRecord(build.dmg, "packages/desktop/package.json build.dmg");
  const linux = assertRecord(build.linux, "packages/desktop/package.json build.linux");
  const mac = assertRecord(build.mac, "packages/desktop/package.json build.mac");
  const win = assertRecord(build.win, "packages/desktop/package.json build.win");

  const config = {
    version: readString(packageJson, "version", "packages/desktop/package.json"),
    productName: readString(build, "productName", "build"),
    artifactName: readString(build, "artifactName", "build"),
    dmgArtifactName: readString(dmg, "artifactName", "build.dmg"),
    targets: {
      linux: readStringArray(linux, "target", "build.linux"),
      mac: readStringArray(mac, "target", "build.mac"),
      win: readStringArray(win, "target", "build.win")
    }
  };

  for (const entry of releaseMatrix) {
    assertTarget(config.targets, entry.platform, entry.target);
  }

  return config;
}

function renderArtifactName(template, variables) {
  return template.replace(/\$\{([^}]+)\}/g, (match, key) => {
    if (!Object.hasOwn(variables, key)) {
      throw new Error(`Unsupported artifactName variable ${match}.`);
    }
    return variables[key];
  });
}

export function expectedReleaseAssets(config, version) {
  const assets = releaseMatrix.map((entry) => {
    const template = entry.artifact === "dmg" ? config.dmgArtifactName : config.artifactName;
    return renderArtifactName(template, {
      productName: config.productName,
      version,
      os: entry.os,
      arch: entry.arch,
      ext: entry.ext
    });
  });
  return [...assets, ...updateMetadataAssets];
}

function formatList(names) {
  return names.length === 0 ? "  (none)" : names.map((name) => `  - ${name}`).join("\n");
}

export async function verifyAssets(directory, expectedNames, logger = console) {
  const entries = await readdir(directory, { withFileTypes: true });
  const actual = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  const expected = [...expectedNames].sort();
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((name) => !actualSet.has(name));
  const extra = actual.filter((name) => !expectedSet.has(name));

  logger.log(`Actual release assets:\n${formatList(actual)}`);
  logger.log(`Expected release assets:\n${formatList(expected)}`);
  if (extra.length > 0) {
    logger.log(`Extra release assets:\n${formatList(extra)}`);
  }

  if (missing.length > 0) {
    throw new Error(`Missing required release assets:\n${formatList(missing)}`);
  }

  return { actual, expected, missing, extra };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dir" || arg === "--version") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${arg}.`);
      }
      options[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--dir=")) {
      options.dir = arg.slice("--dir=".length);
      continue;
    }
    if (arg.startsWith("--version=")) {
      options.version = arg.slice("--version=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.dir) {
    throw new Error("Missing required argument --dir.");
  }
  if (!options.version) {
    throw new Error("Missing required argument --version.");
  }
  return options;
}

export async function runCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const config = await loadDesktopBuildConfig();
  if (options.version !== config.version) {
    throw new Error(`Version mismatch: --version ${options.version} does not match packages/desktop/package.json version ${config.version}.`);
  }

  const expected = expectedReleaseAssets(config, options.version);
  await verifyAssets(resolve(process.cwd(), options.dir), expected);
  console.log("Release asset verification passed.");
}

const isDirectRun = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  try {
    await runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
