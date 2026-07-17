#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listPackage } from "@electron/asar";

const packageRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const repoRoot = resolve(packageRoot, "../..");
const requiredAsarEntries = [
  "/dist/main/main.js",
  "/dist/preload/preload.js",
  "/node_modules/electron-updater",
  "/node_modules/builder-util-runtime",
  "/node_modules/ms"
];
const startupErrorPattern = /MODULE_NOT_FOUND|Cannot find module|Uncaught Exception/i;
const startupReadyEvent = "PLANWEAVE_DESKTOP_STARTUP_SMOKE_READY";

function hasVerifiedStartupMarker(output) {
  for (const line of output.split(/\r?\n/)) {
    let payload;
    try {
      payload = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      payload?.event === startupReadyEvent &&
      payload.rendererLoaded === true &&
      payload.runtimeBridgeAvailable === true &&
      payload.isolatedProjectCount === 0 &&
      payload.appUpdateBridgeAvailable === true &&
      (payload.appUpdateDelivery === "in-app" || payload.appUpdateDelivery === "github-releases") &&
      typeof payload.appVersion === "string" &&
      payload.appVersion.length > 0 &&
      payload.metadataVerified === true
    ) {
      return true;
    }
  }
  return false;
}

async function pathExists(path) {
  await access(path);
  return path;
}

async function firstExisting(paths) {
  for (const path of paths) {
    try {
      return await pathExists(path);
    } catch {
      // Try the next expected packaged output location.
    }
  }
  return undefined;
}

async function resolvePackagedMacAppPath() {
  const releaseDir = resolve(packageRoot, "release");
  const entries = await readdir(releaseDir, { withFileTypes: true }).catch(() => []);
  const candidates = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("mac"))
    .map((entry) => resolve(releaseDir, entry.name, "PlanWeave.app"))
    .sort();
  return (
    (await firstExisting(candidates)) ??
    pathExists(resolve(releaseDir, "mac-arm64", "PlanWeave.app"))
  );
}

async function resolvePackagedUnpackedDir(platform) {
  const releaseDir = resolve(packageRoot, "release");
  const entries = await readdir(releaseDir, { withFileTypes: true }).catch(() => []);
  const candidates = entries
    .filter(
      (entry) =>
        entry.isDirectory() && entry.name.startsWith(platform) && entry.name.endsWith("-unpacked")
    )
    .map((entry) => resolve(releaseDir, entry.name))
    .sort();
  return (
    (await firstExisting(candidates)) ?? pathExists(resolve(releaseDir, `${platform}-unpacked`))
  );
}

async function resolvePackagedApp() {
  const platform = process.env.PLANWEAVE_PACKAGED_PLATFORM ?? process.platform;
  if (process.env.PLANWEAVE_PACKAGED_APP_PATH) {
    const appPath = resolve(process.env.PLANWEAVE_PACKAGED_APP_PATH);
    if (platform === "darwin") {
      return {
        platform,
        appAsarPath: resolve(appPath, "Contents", "Resources", "app.asar"),
        executablePath: resolve(appPath, "Contents", "MacOS", "PlanWeave")
      };
    }
    return {
      platform,
      appAsarPath: resolve(appPath, "resources", "app.asar"),
      executablePath: resolve(appPath, platform === "win32" ? "PlanWeave.exe" : "PlanWeave")
    };
  }

  if (platform === "darwin") {
    const appPath = await resolvePackagedMacAppPath();
    return {
      platform,
      appAsarPath: resolve(appPath, "Contents", "Resources", "app.asar"),
      executablePath: resolve(appPath, "Contents", "MacOS", "PlanWeave")
    };
  }

  if (platform === "linux") {
    const appPath = await resolvePackagedUnpackedDir("linux");
    return {
      platform,
      appAsarPath: resolve(appPath, "resources", "app.asar"),
      executablePath: resolve(appPath, "PlanWeave")
    };
  }

  if (platform === "win32") {
    const appPath = await resolvePackagedUnpackedDir("win");
    return {
      platform,
      appAsarPath: resolve(appPath, "resources", "app.asar"),
      executablePath: resolve(appPath, "PlanWeave.exe")
    };
  }

  throw new Error(`Unsupported packaged app platform: ${platform}`);
}

function normalizeAsarEntry(entry) {
  const normalized = entry.replaceAll("\\", "/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function hasEntry(entries, requiredEntry) {
  return entries.some((entry) => entry === requiredEntry || entry.startsWith(`${requiredEntry}/`));
}

async function verifyAsarContents(appAsarPath) {
  const entries = (await listPackage(appAsarPath)).map(normalizeAsarEntry);
  const missing = requiredAsarEntries.filter((entry) => !hasEntry(entries, entry));
  if (missing.length > 0) {
    throw new Error(
      `Packaged app.asar is missing runtime entries:\n${missing.map((entry) => `- ${entry}`).join("\n")}`
    );
  }
}

async function smokeLaunch(executablePath, platform) {
  const smokeHome = await mkdtemp(join(tmpdir(), "planweave-packaged-smoke-home-"));
  const smokeUserData = await mkdtemp(join(tmpdir(), "planweave-packaged-smoke-user-data-"));
  const launchArgs = platform === "linux" ? ["--no-sandbox"] : [];
  const child = spawn(executablePath, launchArgs, {
    cwd: repoRoot,
    env: {
      ...process.env,
      PLANWEAVE_HOME: smokeHome,
      PLANWEAVE_DESKTOP_SMOKE_USER_DATA_DIR: smokeUserData,
      PLANWEAVE_DESKTOP_STARTUP_SMOKE: "1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let output = "";
  await new Promise((resolve, reject) => {
    let settled = false;
    let ready = false;

    const finish = (code, reason = "exit") => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      child.kill("SIGTERM");
      if (startupErrorPattern.test(output)) {
        reject(new Error(`Packaged app emitted a startup module error:\n${output}`));
        return;
      }
      if (reason === "timeout") {
        reject(
          new Error(`Packaged app did not report startup readiness before timeout:\n${output}`)
        );
        return;
      }
      if (code !== null && code !== 0) {
        reject(new Error(`Packaged app exited with code ${code}:\n${output}`));
        return;
      }
      if (!ready) {
        reject(new Error(`Packaged app exited before reporting startup readiness:\n${output}`));
        return;
      }
      resolve();
    };

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
      if (hasVerifiedStartupMarker(output)) {
        ready = true;
        finish(0);
      }
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stderr.write(text);
      if (startupErrorPattern.test(output)) {
        finish(1);
      }
    });

    const timeout = setTimeout(() => finish(null, "timeout"), 15_000);
    child.on("exit", finish);
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
  });
}

const packagedApp = await resolvePackagedApp();
await verifyAsarContents(packagedApp.appAsarPath);
await smokeLaunch(packagedApp.executablePath, packagedApp.platform);
console.log("Packaged PlanWeave app smoke passed.");
