#!/usr/bin/env node

import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const packagedVerifier = resolve(packageRoot, "scripts/verify-packaged-app.mjs");

export function expectedMacDmgName(version) {
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("Desktop version must be a non-empty string.");
  }
  return `PlanWeave-${version}-universal.dmg`;
}

async function runCommand(file, args, options, report) {
  const result = await execFileAsync(file, args, {
    ...options,
    maxBuffer: 10 * 1024 * 1024
  });
  const output = `${result.stdout}${result.stderr}`.trim();
  report.push(`$ ${file} ${args.join(" ")}`, output || "(no output)");
}

async function cleanupPath(path, errors) {
  try {
    await rm(path, { recursive: true, force: true });
  } catch (error) {
    errors.push(error);
  }
}

export async function verifyMacRelease(options = {}) {
  if (process.platform !== "darwin") {
    throw new Error("macOS release verification must run on macOS.");
  }

  const releaseDir = resolve(options.releaseDir ?? resolve(packageRoot, "release"));
  const packageJson = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
  const dmgPath = resolve(releaseDir, expectedMacDmgName(packageJson.version));
  await access(dmgPath);

  const mountDir = await mkdtemp(join(tmpdir(), "planweave-release-mount-"));
  const installRoot = await mkdtemp(join(tmpdir(), "planweave-release-install-"));
  const installedApp = resolve(installRoot, "PlanWeave.app");
  const report = [];
  let attached = false;
  let failure;
  let cleanupFailure;

  try {
    await runCommand(
      "hdiutil",
      ["attach", "-nobrowse", "-readonly", "-mountpoint", mountDir, dmgPath],
      {},
      report
    );
    attached = true;
    const mountedApp = resolve(mountDir, "PlanWeave.app");
    await access(mountedApp);
    await runCommand("ditto", [mountedApp, installedApp], {}, report);
    await runCommand(
      "codesign",
      ["--verify", "--deep", "--strict", "--verbose=2", installedApp],
      {},
      report
    );
    await runCommand("codesign", ["-dv", "--verbose=4", installedApp], {}, report);
    await runCommand(
      "spctl",
      ["--assess", "--type", "execute", "--verbose=4", installedApp],
      {},
      report
    );
    await runCommand("xcrun", ["stapler", "validate", installedApp], {}, report);
    await runCommand(
      "spctl",
      [
        "--assess",
        "--type",
        "open",
        "--context",
        "context:primary-signature",
        "--verbose=4",
        dmgPath
      ],
      {},
      report
    );
    await runCommand(
      process.execPath,
      [packagedVerifier],
      {
        cwd: resolve(packageRoot, "../.."),
        env: {
          ...process.env,
          PLANWEAVE_PACKAGED_PLATFORM: "darwin",
          PLANWEAVE_PACKAGED_APP_PATH: installedApp
        }
      },
      report
    );
    report.push("macOS release verification passed.");
    await writeFile(resolve(releaseDir, "verification-macos.txt"), `${report.join("\n\n")}\n`);
  } catch (error) {
    failure = error;
  } finally {
    const cleanupErrors = [];
    if (attached) {
      try {
        await execFileAsync("hdiutil", ["detach", mountDir]);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    await cleanupPath(mountDir, cleanupErrors);
    await cleanupPath(installRoot, cleanupErrors);
    if (cleanupErrors.length > 0) {
      cleanupFailure = new AggregateError(
        cleanupErrors,
        "Failed to clean macOS release smoke paths."
      );
      if (failure) {
        console.error(cleanupFailure.message);
      }
    }
  }
  if (failure) {
    throw failure;
  }
  if (cleanupFailure) {
    throw cleanupFailure;
  }
}

const isDirectRun =
  process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  try {
    await verifyMacRelease();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
