#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const requiredSecrets = {
  mac: ["CSC_LINK", "CSC_KEY_PASSWORD"],
  win: ["WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD"]
};

export function assertReleaseSecrets(platform, environment = process.env) {
  const names = requiredSecrets[platform];
  if (!names) {
    throw new Error(`Unsupported release platform: ${platform}`);
  }

  const missing = names.filter((name) => {
    const value = environment[name];
    return typeof value !== "string" || value.trim().length === 0;
  });
  if (missing.length > 0) {
    throw new Error(`Missing required ${platform} release secrets: ${missing.join(", ")}`);
  }

  return names;
}

export function runCli(argv = process.argv.slice(2), environment = process.env) {
  if (argv.length !== 2 || argv[0] !== "--platform") {
    throw new Error("Usage: preflight-release-secrets.mjs --platform <mac|win>");
  }
  const names = assertReleaseSecrets(argv[1], environment);
  console.log(`Release secret preflight passed for ${argv[1]} (${names.length} values present).`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
