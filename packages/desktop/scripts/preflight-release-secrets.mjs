#!/usr/bin/env node

import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const requiredSecrets = {
  mac: ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"],
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

  if (platform === "mac") {
    const apiKeyPath = environment.APPLE_API_KEY.trim();
    if (!isAbsolute(apiKeyPath)) {
      throw new Error("APPLE_API_KEY must be an absolute path to a readable regular .p8 file.");
    }
    try {
      if (!statSync(apiKeyPath).isFile()) {
        throw new Error("not a regular file");
      }
      accessSync(apiKeyPath, constants.R_OK);
    } catch {
      throw new Error("APPLE_API_KEY must be an absolute path to a readable regular .p8 file.");
    }
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
