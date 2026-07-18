#!/usr/bin/env node
import { access, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listPackage } from "@electron/asar";
import { spawnManagedProcess } from "@planweave-ai/runtime";

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
  const { child, tree } = spawnManagedProcess({
    command: executablePath,
    args: launchArgs,
    cwd: repoRoot,
    env: {
      ...process.env,
      PLANWEAVE_HOME: smokeHome,
      PLANWEAVE_DESKTOP_SMOKE_USER_DATA_DIR: smokeUserData,
      PLANWEAVE_DESKTOP_STARTUP_SMOKE: "1"
    },
    graceMs: 1_000
  });
  child.stdin.end();

  let output = "";
  let ready = false;
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    output += text;
    process.stdout.write(text);
    if (hasVerifiedStartupMarker(output)) {
      ready = true;
    }
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    output += text;
    process.stderr.write(text);
  });

  const completion = new Promise((resolveCompletion) => {
    child.once("error", (error) => resolveCompletion({ kind: "error", error }));
    child.once("close", (code, signal) => resolveCompletion({ kind: "close", code, signal }));
  });
  let timeout;
  const outcome = await Promise.race([
    completion,
    new Promise((resolveTimeout) => {
      timeout = setTimeout(() => resolveTimeout({ kind: "timeout" }), 30_000);
    })
  ]);
  clearTimeout(timeout);

  if (outcome.kind === "timeout") {
    try {
      await tree.terminate("packaged startup smoke timeout");
    } catch (cleanupError) {
      throw new Error(
        `Packaged app startup timed out and managed process-tree cleanup failed:\n${output}`,
        { cause: cleanupError }
      );
    }
    throw new Error(`Packaged app did not exit normally before timeout:\n${output}`);
  }
  if (outcome.kind === "error") {
    if (tree.isAlive()) {
      try {
        await tree.terminate("packaged startup smoke spawn failure");
      } catch (cleanupError) {
        throw new Error("Packaged app failed to spawn and process-tree cleanup failed.", {
          cause: new AggregateError([outcome.error, cleanupError])
        });
      }
    }
    throw outcome.error;
  }

  await tree.exited;
  if (startupErrorPattern.test(output)) {
    throw new Error(`Packaged app emitted a startup module error:\n${output}`);
  }
  if (outcome.code !== 0) {
    throw new Error(
      `Packaged app exited with code ${String(outcome.code)}${outcome.signal ? ` (${outcome.signal})` : ""}:\n${output}`
    );
  }
  if (!ready) {
    throw new Error(`Packaged app exited before reporting startup readiness:\n${output}`);
  }
}

async function writeCiReport(report) {
  const reportPath = process.env.PLANWEAVE_CI_REPORT_PATH;
  if (!reportPath) {
    return;
  }
  const resolvedReportPath = resolve(reportPath);
  await mkdir(dirname(resolvedReportPath), { recursive: true });
  await writeFile(resolvedReportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

let stage = "resolve-packaged-app";
const reportPlatform = process.env.PLANWEAVE_PACKAGED_PLATFORM ?? process.platform;
try {
  const packagedApp = await resolvePackagedApp();
  stage = "verify-asar";
  await verifyAsarContents(packagedApp.appAsarPath);
  stage = "verify-startup";
  await smokeLaunch(packagedApp.executablePath, packagedApp.platform);
  stage = "complete";
  await writeCiReport({
    schemaVersion: 1,
    platform: reportPlatform,
    status: "passed",
    checks: {
      asarRuntimeEntries: true,
      strictStartupMarker: true,
      rendererAndRuntimeBridge: true,
      normalProcessExit: true
    }
  });
  console.log("Packaged PlanWeave app smoke passed.");
} catch (error) {
  await writeCiReport({
    schemaVersion: 1,
    platform: reportPlatform,
    status: "failed",
    failedStage: stage
  });
  throw error;
}
