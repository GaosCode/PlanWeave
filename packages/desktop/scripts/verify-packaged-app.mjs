#!/usr/bin/env node
import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listPackage } from "@electron/asar";
import { spawnManagedProcess } from "@planweave-ai/runtime";
import { redactCiText } from "../../../scripts/redact-ci-test-artifacts.mjs";

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
const packagedStartupBudgetMs = 45_000;
const maxCapturedOutputBytes = 64 * 1024;
const inheritedEnvironmentKeys = new Set([
  "APPDATA",
  "COMSPEC",
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WAYLAND_DISPLAY",
  "WINDIR",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR"
]);

function buildSmokeEnvironment(smokeHome, smokeUserData, startupReportPath) {
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && inheritedEnvironmentKeys.has(key.toUpperCase())) {
      environment[key] = value;
    }
  }
  return {
    ...environment,
    PLANWEAVE_HOME: smokeHome,
    PLANWEAVE_DESKTOP_SMOKE_USER_DATA_DIR: smokeUserData,
    PLANWEAVE_DESKTOP_STARTUP_SMOKE: "1",
    PLANWEAVE_DESKTOP_STARTUP_SMOKE_REPORT_PATH: startupReportPath
  };
}

function appendBoundedOutput(output, chunk) {
  const combined = output + chunk;
  if (Buffer.byteLength(combined) <= maxCapturedOutputBytes) {
    return combined;
  }
  return Buffer.from(combined).subarray(-maxCapturedOutputBytes).toString();
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

class PackagedStartupTimeoutError extends Error {
  constructor(message, startupTiming) {
    super(`${message} (elapsedMs=${startupTiming.elapsedMs}, budgetMs=${startupTiming.budgetMs})`);
    this.startupTiming = startupTiming;
  }
}

function measuredStartupTiming(startedAt) {
  return {
    elapsedMs: Math.max(0, Date.now() - startedAt),
    budgetMs: packagedStartupBudgetMs
  };
}

function sanitizedDiagnostic(value, sensitivePaths = []) {
  const configuredPaths = [
    process.env.PLANWEAVE_PACKAGED_APP_PATH,
    process.env.PLANWEAVE_CI_REPORT_PATH
  ].filter((path) => typeof path === "string");
  return redactCiText(value, [...configuredPaths, ...sensitivePaths]);
}

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

function createStartupReportReadiness(reportPath) {
  let readInFlight = false;
  let timer;
  const promise = new Promise((resolveReadiness) => {
    timer = setInterval(() => {
      if (readInFlight) {
        return;
      }
      readInFlight = true;
      void readFile(reportPath, "utf8")
        .then((report) => {
          if (hasVerifiedStartupMarker(report)) {
            resolveReadiness({ kind: "ready" });
          }
        })
        .catch((error) => {
          if (error?.code !== "ENOENT") {
            resolveReadiness({ kind: "report-error", error });
          }
        })
        .finally(() => {
          readInFlight = false;
        });
    }, 50);
  });
  return {
    promise,
    stop() {
      clearInterval(timer);
    }
  };
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
  const startupReportPath = join(smokeUserData, "startup-ready.json");
  const launchArgs = platform === "linux" ? ["--no-sandbox"] : [];
  const startupStartedAt = Date.now();
  const { child, tree } = spawnManagedProcess({
    command: executablePath,
    args: launchArgs,
    cwd: repoRoot,
    env: buildSmokeEnvironment(smokeHome, smokeUserData, startupReportPath),
    graceMs: 1_000
  });
  child.stdin.end();

  let output = "";
  let reportReady;
  const readiness = new Promise((resolveReadiness) => {
    reportReady = () => resolveReadiness({ kind: "ready" });
  });
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    output = appendBoundedOutput(output, text);
    if (hasVerifiedStartupMarker(output)) {
      reportReady();
    }
  });
  child.stderr.on("data", (chunk) => {
    output = appendBoundedOutput(output, chunk.toString());
  });

  const completion = new Promise((resolveCompletion) => {
    child.once("error", (error) => resolveCompletion({ kind: "error", error }));
    child.once("close", (code, signal) => resolveCompletion({ kind: "close", code, signal }));
  });
  const reportReadiness = createStartupReportReadiness(startupReportPath);
  let timeout;
  const outcome = await Promise.race([
    readiness,
    reportReadiness.promise,
    completion,
    new Promise((resolveTimeout) => {
      timeout = setTimeout(() => resolveTimeout({ kind: "timeout" }), packagedStartupBudgetMs);
    })
  ]);
  clearTimeout(timeout);
  reportReadiness.stop();
  const startupTiming = measuredStartupTiming(startupStartedAt);
  const sensitivePaths = [executablePath, smokeHome, smokeUserData];
  const diagnosticOutput = () => sanitizedDiagnostic(output, sensitivePaths);

  if (outcome.kind === "timeout") {
    try {
      await tree.terminate("packaged startup smoke timeout");
    } catch (cleanupError) {
      throw new PackagedStartupTimeoutError(
        `Packaged app startup timed out and managed process-tree cleanup failed: ${sanitizedDiagnostic(errorMessage(cleanupError), sensitivePaths)}\n${diagnosticOutput()}`,
        startupTiming
      );
    }
    throw new PackagedStartupTimeoutError(
      `Packaged app did not report startup readiness before timeout:\n${diagnosticOutput()}`,
      startupTiming
    );
  }
  if (outcome.kind === "report-error") {
    try {
      await tree.terminate("packaged startup smoke report failure");
    } catch (cleanupError) {
      throw new Error(
        `Packaged startup report read failed and managed process-tree cleanup failed: ${sanitizedDiagnostic(`${errorMessage(outcome.error)}; ${errorMessage(cleanupError)}`, sensitivePaths)}`
      );
    }
    throw new Error(
      `Packaged startup report read failed: ${sanitizedDiagnostic(errorMessage(outcome.error), sensitivePaths)}`
    );
  }
  if (outcome.kind === "error") {
    if (tree.isAlive()) {
      try {
        await tree.terminate("packaged startup smoke spawn failure");
      } catch (cleanupError) {
        throw new Error(
          `Packaged app failed to spawn and process-tree cleanup failed: ${sanitizedDiagnostic(`${errorMessage(outcome.error)}; ${errorMessage(cleanupError)}`, sensitivePaths)}`
        );
      }
    }
    throw new Error(
      `Packaged app failed to spawn: ${sanitizedDiagnostic(errorMessage(outcome.error), sensitivePaths)}`
    );
  }
  if (outcome.kind === "close") {
    const exitDetail = `code ${String(outcome.code)}${outcome.signal ? `, signal ${outcome.signal}` : ""}`;
    try {
      await tree.terminate("packaged startup smoke early exit");
    } catch (cleanupError) {
      throw new Error(
        `Packaged app exited before reporting startup readiness (${exitDetail}) and managed process-tree cleanup failed: ${sanitizedDiagnostic(errorMessage(cleanupError), sensitivePaths)}\n${diagnosticOutput()}`
      );
    }
    throw new Error(
      `Packaged app exited before reporting startup readiness (${exitDetail}):\n${diagnosticOutput()}`
    );
  }

  let termination;
  try {
    termination = await tree.terminate("packaged startup smoke complete");
  } catch (cleanupError) {
    throw new Error(
      `Packaged app reported startup readiness but managed process-tree cleanup failed: ${sanitizedDiagnostic(errorMessage(cleanupError), sensitivePaths)}\n${diagnosticOutput()}`
    );
  }
  if (termination.outcome === "already_exited") {
    throw new Error(
      `Packaged app root exited before managed process-tree cleanup could be verified:\n${diagnosticOutput()}`
    );
  }
  if (termination.outcome !== "graceful" && termination.outcome !== "forced") {
    throw new Error(
      `Packaged app returned an unsupported managed process-tree cleanup outcome: ${String(termination.outcome)}`
    );
  }
  const completionOutcome = await completion;
  if (completionOutcome.kind === "error") {
    throw new Error(
      `Packaged app failed while completing managed process-tree cleanup: ${sanitizedDiagnostic(errorMessage(completionOutcome.error), sensitivePaths)}`
    );
  }
  if (startupErrorPattern.test(output)) {
    throw new Error(`Packaged app emitted a startup module error:\n${diagnosticOutput()}`);
  }
  return startupTiming;
}

function redactReportValue(value) {
  if (typeof value === "string") {
    return sanitizedDiagnostic(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactReportValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactReportValue(entry)])
    );
  }
  return value;
}

async function writeCiReport(report) {
  const reportPath = process.env.PLANWEAVE_CI_REPORT_PATH;
  if (!reportPath) {
    return;
  }
  const resolvedReportPath = isAbsolute(reportPath) ? reportPath : resolve(repoRoot, reportPath);
  await mkdir(dirname(resolvedReportPath), { recursive: true });
  await writeFile(
    resolvedReportPath,
    `${JSON.stringify(redactReportValue(report), null, 2)}\n`,
    "utf8"
  );
}

let stage = "resolve-packaged-app";
const reportPlatform = process.env.PLANWEAVE_PACKAGED_PLATFORM ?? process.platform;
try {
  const packagedApp = await resolvePackagedApp();
  stage = "verify-asar";
  await verifyAsarContents(packagedApp.appAsarPath);
  stage = "verify-startup";
  const startupTiming = await smokeLaunch(packagedApp.executablePath, packagedApp.platform);
  stage = "complete";
  await writeCiReport({
    schemaVersion: 1,
    platform: reportPlatform,
    status: "passed",
    startupTiming,
    checks: {
      asarRuntimeEntries: true,
      strictStartupMarker: true,
      rendererAndRuntimeBridge: true,
      managedProcessTreeTerminated: true
    }
  });
  console.log("Packaged PlanWeave app smoke passed.");
} catch (error) {
  const diagnostic = sanitizedDiagnostic(errorMessage(error));
  try {
    await writeCiReport({
      schemaVersion: 1,
      platform: reportPlatform,
      status: "failed",
      failedStage: stage,
      ...(error instanceof PackagedStartupTimeoutError
        ? { startupTiming: error.startupTiming }
        : {}),
      diagnostic
    });
  } catch (reportError) {
    console.error(
      `Packaged smoke report write failed: ${sanitizedDiagnostic(errorMessage(reportError))}`
    );
  }
  console.error(diagnostic);
  process.exitCode = 1;
}
