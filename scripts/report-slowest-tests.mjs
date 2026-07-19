#!/usr/bin/env node

import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const testSuitePattern = /<testsuite\b([^>]*)>/g;
const attributePattern = /([A-Za-z_:][\w:.-]*)="([^"]*)"/g;
const defaultLimit = 10;

function decodeXmlAttribute(value) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function attributes(source) {
  const result = new Map();
  for (const match of source.matchAll(attributePattern)) {
    result.set(match[1], decodeXmlAttribute(match[2]));
  }
  return result;
}

export function parseJUnitSuites(source) {
  const durations = new Map();
  for (const match of source.matchAll(testSuitePattern)) {
    const suite = attributes(match[1]);
    const name = suite.get("name");
    const rawDuration = suite.get("time");
    const durationSeconds = rawDuration === undefined ? Number.NaN : Number(rawDuration);
    if (!name || !Number.isFinite(durationSeconds) || durationSeconds < 0) {
      throw new Error("JUnit testsuite entries must contain a name and non-negative time.");
    }
    durations.set(name, (durations.get(name) ?? 0) + durationSeconds);
  }
  if (durations.size === 0) {
    throw new Error("JUnit report contains no testsuite entries.");
  }
  return [...durations].map(([name, durationSeconds]) => ({ name, durationSeconds }));
}

function markdownCode(value) {
  return `\`${value.replaceAll("`", "\\`").replaceAll("|", "\\|")}\``;
}

export function formatSlowTestSummary(label, suites, limit = defaultLimit) {
  const slowest = [...suites]
    .sort((left, right) => right.durationSeconds - left.durationSeconds)
    .slice(0, limit);
  const rows = slowest.map(
    (suite, index) =>
      `| ${String(index + 1)} | ${markdownCode(suite.name)} | ${suite.durationSeconds.toFixed(2)} s |`
  );
  return [
    `## Slowest test files: ${label}`,
    "",
    "| Rank | Test file | Duration |",
    "| ---: | --- | ---: |",
    ...rows
  ].join("\n");
}

async function main(args) {
  const [reportPath, label] = args;
  if (!reportPath || !label) {
    throw new Error("Usage: report-slowest-tests.mjs <junit-report> <label>");
  }
  const report = await readFile(resolve(reportPath), "utf8");
  const summary = formatSlowTestSummary(label, parseJUnitSuites(report));
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    await appendFile(summaryPath, `${summary}\n`, "utf8");
  } else {
    process.stdout.write(`${summary}\n`);
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  await main(process.argv.slice(2));
}
