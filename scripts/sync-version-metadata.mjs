#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const checkOnly = process.argv.includes("--check");

const packageJsonPaths = [
  "package.json",
  "packages/runtime/package.json",
  "packages/cli/package.json",
  "packages/desktop/package.json",
  "packages/mcp/package.json"
];

const readmePaths = ["README.md", "readme/README.zh-CN.md"];

async function readText(relativePath) {
  return readFile(join(repoRoot, relativePath), "utf8");
}

async function readJson(relativePath) {
  return JSON.parse(await readText(relativePath));
}

function stringifyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function badge(label, value, color) {
  return `  <img alt="${label}" src="https://img.shields.io/badge/${encodeURIComponent(label)}-${encodeURIComponent(value).replace(/-/g, "--")}-${color}?style=for-the-badge" />`;
}

function renderBadgeBlock(metadata) {
  return [
    "<!-- planweave-badges:start -->",
    '<p align="center">',
    badge("version", metadata.version, "orange"),
    badge("license", metadata.license, "yellow.svg"),
    badge("language", "TypeScript", "3178c6"),
    badge("runtime", "Node.js", "43853d"),
    badge("desktop", "Electron", "47848f"),
    badge("agents", "Codex | Claude Code | OpenCode | Pi", "6f42c1"),
    "</p>",
    "<!-- planweave-badges:end -->"
  ].join("\n");
}

function replaceBadgeBlock(markdown, metadata, relativePath) {
  const rendered = renderBadgeBlock(metadata);
  const markerPattern = /<!-- planweave-badges:start -->[\s\S]*?<!-- planweave-badges:end -->/;
  if (markerPattern.test(markdown)) {
    return markdown.replace(markerPattern, rendered);
  }

  const badgeParagraphPattern = /<p align="center">\n(?:  <img alt="(?:version|license|language|runtime|desktop|agents)" src="https:\/\/img\.shields\.io\/badge\/[^"]+" \/>\n)+<\/p>/;
  if (!badgeParagraphPattern.test(markdown)) {
    throw new Error(`Could not find README badge block in ${relativePath}.`);
  }
  return markdown.replace(badgeParagraphPattern, rendered);
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

const rootPackage = await readJson("package.json");
const metadata = {
  version: rootPackage.version,
  license: rootPackage.license
};
const changedFiles = [];

for (const packageJsonPath of packageJsonPaths) {
  const packageJson = await readJson(packageJsonPath);
  if (packageJson.version !== metadata.version) {
    packageJson.version = metadata.version;
    await writeIfChanged(packageJsonPath, stringifyJson(packageJson), changedFiles);
  }
}

for (const readmePath of readmePaths) {
  const nextReadme = replaceBadgeBlock(await readText(readmePath), metadata, readmePath);
  await writeIfChanged(readmePath, nextReadme, changedFiles);
}

if (changedFiles.length > 0) {
  const message = `Version metadata is out of sync:\n${changedFiles.map((file) => `- ${file}`).join("\n")}`;
  if (checkOnly) {
    console.error(message);
    console.error("Run `pnpm sync:versions` to update generated version metadata.");
    process.exit(1);
  }
  console.log(`Updated version metadata:\n${changedFiles.map((file) => `- ${file}`).join("\n")}`);
}
