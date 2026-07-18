#!/usr/bin/env node

import { readdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

const allowedExtensions = new Set([".json", ".log", ".txt", ".xml"]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redacted(content) {
  let result = content;
  const paths = new Set(
    [
      process.cwd(),
      process.env.GITHUB_WORKSPACE,
      process.env.RUNNER_TEMP,
      process.env.HOME,
      process.env.USERPROFILE
    ].filter((value) => typeof value === "string" && value.length > 1)
  );
  for (const path of [...paths].sort((left, right) => right.length - left.length)) {
    result = result.replace(new RegExp(escapeRegExp(path), "g"), "<redacted-path>");
  }

  result = result
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[REDACTED PEM]")
    .replace(
      /(["']?(?:authorization|cookie|descriptor|endpoint|hostname|password|secret|token)["']?\s*[:=]\s*["']?)[^\s,"'<>]+/gi,
      "$1[REDACTED]"
    )
    .replace(/(?:\/Users|\/home)\/[^/\s<>"]+\/[^\s<>"]+/g, "<redacted-user-path>")
    .replace(/[A-Za-z]:\\Users\\[^\\\s<>"]+\\[^\s<>"]+/g, "<redacted-user-path>");
  return result;
}

async function reportFiles(root) {
  const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  const files = [];
  for (const entry of entries) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await reportFiles(path)));
    } else if (entry.isFile() && allowedExtensions.has(extname(entry.name).toLowerCase())) {
      files.push(path);
    }
  }
  return files;
}

const roots = process.argv.slice(2);
if (roots.length === 0) {
  throw new Error("Usage: redact-ci-test-artifacts.mjs <report-directory> [...directories]");
}

let fileCount = 0;
for (const root of roots) {
  for (const path of await reportFiles(resolve(root))) {
    const content = await readFile(path, "utf8");
    await writeFile(path, redacted(content), "utf8");
    fileCount += 1;
  }
}
console.log(`Redacted ${fileCount} CI test artifact file(s).`);
