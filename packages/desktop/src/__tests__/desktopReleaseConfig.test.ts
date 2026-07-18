import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const desktopRoot = resolve(repoRoot, "packages/desktop");
const preflightPath = resolve(desktopRoot, "scripts/preflight-release-secrets.mjs");
const junitWorkflowVerificationTimeoutMs = 60_000;

async function loadConfig(name: string): Promise<Record<string, unknown>> {
  const desktopRequire = createRequire(resolve(desktopRoot, "package.json"));
  const electronBuilderRequire = createRequire(
    desktopRequire.resolve("electron-builder/package.json")
  );
  const { getConfig } = electronBuilderRequire("app-builder-lib/out/util/config/load.js") as {
    getConfig: <T>(
      request: {
        packageKey: string;
        configFilename: string;
        projectDir: string;
        packageMetadata: null;
      },
      configPath: string
    ) => Promise<{ result: T } | null>;
  };
  const loaded = await getConfig<Record<string, unknown>>(
    {
      packageKey: "build",
      configFilename: "electron-builder",
      projectDir: desktopRoot,
      packageMetadata: null
    },
    name
  );
  if (loaded === null) {
    throw new Error(`electron-builder did not load ${name}`);
  }
  return loaded.result;
}

function occurrenceCount(source: string, value: string): number {
  return source.split(value).length - 1;
}

describe("desktop release configuration", () => {
  it("serializes package-level workspace consumer builds without serializing the root build", async () => {
    const [rootPackage, cliPackage, desktopPackage, coordinator] = await Promise.all([
      readFile(resolve(repoRoot, "package.json"), "utf8"),
      readFile(resolve(repoRoot, "packages/cli/package.json"), "utf8"),
      readFile(resolve(desktopRoot, "package.json"), "utf8"),
      readFile(resolve(repoRoot, "scripts/run-workspace-consumer-build.ts"), "utf8")
    ]);
    const rootScripts = (JSON.parse(rootPackage) as { scripts: Record<string, string> }).scripts;
    const cliScripts = (JSON.parse(cliPackage) as { scripts: Record<string, string> }).scripts;
    const desktopScripts = (JSON.parse(desktopPackage) as { scripts: Record<string, string> })
      .scripts;

    expect(cliScripts.build).toBe("tsx ../../scripts/run-workspace-consumer-build.ts cli");
    expect(desktopScripts.build).toBe("tsx ../../scripts/run-workspace-consumer-build.ts desktop");
    expect(desktopScripts["build:standalone"]).toContain(
      "pnpm --filter @planweave-ai/runtime build"
    );
    expect(desktopScripts["build:standalone"]).toContain("pnpm build:workspace");
    expect(rootScripts.build).toContain(
      "@planweave-ai/cli --filter @planweave-ai/desktop build:workspace"
    );
    expect(coordinator).toContain("withAdvisoryDirectoryLock");
    expect(coordinator).toContain(".planweave-workspace-consumer-build.lock");
  });

  it("keeps local pack and dist commands explicitly unsigned", async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(desktopRoot, "package.json"), "utf8")
    ) as {
      scripts: Record<string, string>;
      build: { mac: Record<string, unknown>; extraResources: Array<Record<string, unknown>> };
    };
    const localConfig = await loadConfig("electron-builder.local.cjs");

    for (const [name, command] of Object.entries(packageJson.scripts)) {
      if (name.startsWith("pack:") || name.startsWith("dist:")) {
        expect(command).toContain("--config electron-builder.local.cjs");
        expect(command).toContain("pnpm build:metadata:local");
      }
    }
    expect(packageJson.build.mac).not.toHaveProperty("identity");
    expect(localConfig).toMatchObject({
      appId: "dev.planweave.desktop",
      productName: "PlanWeave",
      directories: { output: "release" },
      files: ["dist/**/*", "package.json"],
      artifactName: expect.stringContaining("development-unsigned"),
      mac: { identity: null, forceCodeSigning: false, hardenedRuntime: false },
      win: { forceCodeSigning: false, signExecutable: false }
    });
    expect(packageJson.build.extraResources).toEqual([
      {
        from: "build/generated/planweave-build-metadata.json",
        to: "planweave-build-metadata.json"
      }
    ]);
  });

  it("uses only the OV PFX Authenticode provider for Windows release signing", async () => {
    const releaseConfig = await loadConfig("electron-builder.release.cjs");
    const win = releaseConfig.win as Record<string, unknown>;

    expect(win).toMatchObject({
      target: ["nsis", "zip"],
      forceCodeSigning: true,
      signtoolOptions: {
        rfc3161TimeStampServer: "http://timestamp.digicert.com",
        signingHashAlgorithms: ["sha256"]
      }
    });
    expect(releaseConfig).toMatchObject({
      appId: "dev.planweave.desktop",
      productName: "PlanWeave",
      directories: { output: "release" },
      files: ["dist/**/*", "package.json"],
      extraResources: [
        {
          from: "build/generated/planweave-build-metadata.json",
          to: "planweave-build-metadata.json"
        }
      ],
      nsis: {
        allowToChangeInstallationDirectory: true,
        oneClick: false,
        perMachine: false
      }
    });
    expect(win).not.toHaveProperty("azureSignOptions");
    expect(JSON.stringify(releaseConfig)).not.toContain("certificatePassword");
  });

  it("enables hardened macOS signing and notarization with explicit entitlements", async () => {
    const releaseConfig = await loadConfig("electron-builder.release.cjs");

    expect(releaseConfig.mac).toEqual({
      category: "public.app-category.developer-tools",
      icon: "build/icon.icns",
      x64ArchFiles: "**/node_modules/electron-liquid-glass/prebuilds/darwin-*/**/*.node",
      target: ["dmg", "zip"],
      forceCodeSigning: true,
      hardenedRuntime: true,
      notarize: true,
      entitlements: "build/entitlements.mac.plist",
      entitlementsInherit: "build/entitlements.mac.inherit.plist"
    });
    const entitlements = await Promise.all([
      readFile(resolve(desktopRoot, "build/entitlements.mac.plist"), "utf8"),
      readFile(resolve(desktopRoot, "build/entitlements.mac.inherit.plist"), "utf8")
    ]);
    for (const source of entitlements) {
      expect(source).toContain("com.apple.security.cs.allow-jit");
      expect(source).not.toContain("com.apple.security.cs.allow-unsigned-executable-memory");
      expect(source).not.toContain("com.apple.security.get-task-allow");
    }
  });

  it("fails closed before packaging when either platform signing secret is missing", async () => {
    await expect(
      execFileAsync(process.execPath, [preflightPath, "--platform", "win"], {
        cwd: repoRoot,
        env: {}
      })
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("WIN_CSC_LINK, WIN_CSC_KEY_PASSWORD")
    });
    await expect(
      execFileAsync(process.execPath, [preflightPath, "--platform", "mac"], {
        cwd: repoRoot,
        env: { CSC_LINK: "present" }
      })
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "CSC_KEY_PASSWORD, APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER"
      )
    });
  });

  it("requires APPLE_API_KEY to be an absolute readable regular file", async () => {
    const environment = {
      CSC_LINK: "present",
      CSC_KEY_PASSWORD: "present",
      APPLE_API_KEY: "inline-base64-key-content",
      APPLE_API_KEY_ID: "present",
      APPLE_API_ISSUER: "present"
    };
    await expect(
      execFileAsync(process.execPath, [preflightPath, "--platform", "mac"], {
        cwd: repoRoot,
        env: environment
      })
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("absolute path to a readable regular .p8 file")
    });

    const temporaryDirectory = await mkdtemp(join(tmpdir(), "planweave-apple-key-test-"));
    const apiKeyPath = join(temporaryDirectory, "AuthKey_TEST.p8");
    try {
      await writeFile(apiKeyPath, "test-key-content", { mode: 0o600 });
      const result = await execFileAsync(process.execPath, [preflightPath, "--platform", "mac"], {
        cwd: repoRoot,
        env: { ...environment, APPLE_API_KEY: apiKeyPath }
      });
      expect(result.stdout).toContain("Release secret preflight passed for mac");
      expect(result.stdout).not.toContain(apiKeyPath);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("accepts complete placeholder credentials without logging their values", async () => {
    const pfxMarker = "test-pfx-value";
    const passwordMarker = "test-password-value";
    const result = await execFileAsync(process.execPath, [preflightPath, "--platform", "win"], {
      cwd: repoRoot,
      env: {
        WIN_CSC_LINK: pfxMarker,
        WIN_CSC_KEY_PASSWORD: passwordMarker
      }
    });

    expect(result.stdout).toContain("Release secret preflight passed for win");
    expect(result.stdout).not.toContain(pfxMarker);
    expect(result.stdout).not.toContain(passwordMarker);
  });

  it("runs platform preflight before release-only builder config", async () => {
    const workflow = await readFile(
      resolve(repoRoot, ".github/workflows/desktop-release.yml"),
      "utf8"
    );
    const macPreflight = workflow.indexOf("preflight-release-secrets.mjs --platform mac");
    const winPreflight = workflow.indexOf("preflight-release-secrets.mjs --platform win");
    const macBuild = workflow.indexOf("Build signed macOS installers");
    const winBuild = workflow.indexOf("Build signed Windows installers with OV PFX");
    const metadata = workflow.indexOf("Generate release build metadata");

    expect(workflow).toContain("environment: desktop-release");
    expect(macPreflight).toBeGreaterThan(-1);
    expect(winPreflight).toBeGreaterThan(-1);
    expect(macPreflight).toBeLessThan(macBuild);
    expect(winPreflight).toBeLessThan(winBuild);
    expect(metadata).toBeGreaterThan(-1);
    expect(metadata).toBeLessThan(macBuild);
    expect(metadata).toBeLessThan(winBuild);
    expect(workflow).toContain(
      "--channel release --signed-distribution ${{ matrix.signedDistribution }}"
    );
    expect(workflow).toContain('signedDistribution: "true"');
    expect(workflow).toContain('signedDistribution: "false"');
    expect(workflow).toContain("--config electron-builder.release.cjs");
    expect(workflow).toContain("secrets.WINDOWS_OV_PFX");
    expect(workflow).not.toContain("azureSignOptions");
  });

  it("gates artifact upload on platform verification of the actual release installers", async () => {
    const workflow = await readFile(
      resolve(repoRoot, ".github/workflows/desktop-release.yml"),
      "utf8"
    );
    const macVerification = workflow.indexOf("verify-macos-release.mjs");
    const windowsVerification = workflow.indexOf("verify-windows-release.ps1");
    const upload = workflow.indexOf("name: Upload desktop artifacts");
    const publishJob = workflow.indexOf("\n  publish:");

    expect(workflow).toContain("APPLE_API_KEY_BASE64: ${{ secrets.APPLE_API_KEY }}");
    expect(workflow).toContain('key_path="${RUNNER_TEMP}/planweave-notarization-key.p8"');
    expect(workflow).toContain('base64 -D > "${key_path}"');
    expect(workflow).toContain('chmod 600 "${key_path}"');
    expect(workflow).toContain("printf 'APPLE_API_KEY=%s\\n'");
    expect(workflow).not.toMatch(/APPLE_API_KEY:\s*\$\{\{\s*secrets\./);
    expect(workflow).toContain("if: always() && matrix.releasePlatform == 'mac'");
    expect(workflow).toContain('rm -f -- "${RUNNER_TEMP}/planweave-notarization-key.p8"');
    expect(workflow).toContain("packages/desktop/release/verification-*.txt");
    expect(macVerification).toBeGreaterThan(-1);
    expect(windowsVerification).toBeGreaterThan(-1);
    expect(macVerification).toBeLessThan(upload);
    expect(windowsVerification).toBeLessThan(upload);
    expect(workflow).toContain("needs: build");
    expect(workflow.slice(publishJob)).toContain("needs: verify-assets");
  });

  it("keeps platform verification fail closed and free of signing secrets", async () => {
    const [packagedVerifier, macVerifier, windowsVerifier] = await Promise.all([
      readFile(resolve(desktopRoot, "scripts/verify-packaged-app.mjs"), "utf8"),
      readFile(resolve(desktopRoot, "scripts/verify-macos-release.mjs"), "utf8"),
      readFile(resolve(desktopRoot, "scripts/verify-windows-release.ps1"), "utf8")
    ]);

    expect(packagedVerifier).toContain("hasVerifiedStartupMarker(output)");
    expect(packagedVerifier).toContain("payload.runtimeBridgeAvailable === true");
    expect(packagedVerifier).toContain("payload.appUpdateBridgeAvailable === true");
    expect(packagedVerifier).toContain("payload.metadataVerified === true");
    expect(packagedVerifier).not.toContain(
      'output.includes("PLANWEAVE_DESKTOP_STARTUP_SMOKE_READY")'
    );
    expect(macVerifier).toContain('"--verify", "--deep", "--strict", "--verbose=2"');
    expect(macVerifier).toContain('"stapler", "validate"');
    expect(macVerifier).toContain("PLANWEAVE_PACKAGED_APP_PATH");
    expect(windowsVerifier).toContain('"verify", "/pa", "/all", "/v", "/tw"');
    expect(windowsVerifier).toContain('"/S", "/D=$installDir"');
    expect(windowsVerifier).toContain("Remove-Item -LiteralPath $installDir -Recurse -Force");
    for (const source of [macVerifier, windowsVerifier]) {
      expect(source).not.toMatch(/CSC_KEY_PASSWORD|WIN_CSC_LINK|APPLE_API_KEY/);
    }
  });

  it("verifies the Windows uninstaller signature before executing it", async () => {
    const windowsVerifier = await readFile(
      resolve(desktopRoot, "scripts/verify-windows-release.ps1"),
      "utf8"
    );
    const uninstallBlock = windowsVerifier.slice(
      windowsVerifier.indexOf("if (Test-Path -LiteralPath $uninstaller -PathType Leaf)")
    );
    const signatureVerification = uninstallBlock.indexOf(
      "Assert-ValidAuthenticodeSignature -ArtifactPath $uninstaller"
    );
    const uninstallExecution = uninstallBlock.indexOf(
      "Invoke-CheckedProcess -FilePath $uninstaller"
    );

    expect(signatureVerification).toBeGreaterThan(-1);
    expect(uninstallExecution).toBeGreaterThan(signatureVerification);
    expect(
      occurrenceCount(windowsVerifier, "Assert-ValidAuthenticodeSignature -ArtifactPath")
    ).toBe(3);
    expect(windowsVerifier).toContain('"verify", "/pa", "/all", "/v", "/tw", $ArtifactPath');
  });

  it("keeps unit, platform-matrix, and unsigned Windows packaged gates explicit", async () => {
    const [
      workflow,
      desktopSmokeWorkflow,
      packageSource,
      packagedVerifier,
      packagedStartupSmoke,
      desktopMain,
      redactor
    ] = await Promise.all([
      readFile(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8"),
      readFile(resolve(repoRoot, ".github/workflows/desktop-smoke.yml"), "utf8"),
      readFile(resolve(desktopRoot, "package.json"), "utf8"),
      readFile(resolve(desktopRoot, "scripts/verify-packaged-app.mjs"), "utf8"),
      readFile(resolve(desktopRoot, "src/main/smoke.ts"), "utf8"),
      readFile(resolve(desktopRoot, "src/main/main.ts"), "utf8"),
      readFile(resolve(repoRoot, "scripts/redact-ci-test-artifacts.mjs"), "utf8")
    ]);
    const packageJson = JSON.parse(packageSource) as { scripts: Record<string, string> };

    expect(workflow).toContain("group: ci-${{ github.workflow }}-${{ github.ref }}");
    expect(workflow).toContain("cancel-in-progress: true");
    expect(workflow).toContain("name: Ubuntu build, lint, and unit tests");
    expect(workflow).toContain("pnpm test:unit --maxWorkers=2");
    expect(workflow).not.toContain("pnpm test:unit -- --maxWorkers=2");
    expect(workflow).toContain("name: Platform tests (${{ matrix.os }})");
    expect(workflow).toContain("- ubuntu-latest");
    expect(workflow).toContain("- windows-latest");
    expect(workflow).toContain("pnpm test:platform --maxWorkers=2");
    expect(workflow).not.toContain("pnpm test:platform -- --maxWorkers=2");
    expect(workflow).toContain("name: Windows unsigned packaged smoke");
    expect(workflow).toContain("pnpm --dir packages/desktop build");
    expect(workflow).toContain("pnpm --dir packages/desktop pack:win");
    expect(workflow).toContain("pnpm --dir packages/desktop smoke:packaged:win");
    expect(workflow).toContain('CSC_IDENTITY_AUTO_DISCOVERY: "false"');
    expect(workflow).toContain("PLANWEAVE_CI_REPORT_PATH: reports/windows-packaged-smoke.json");
    expect(workflow).not.toContain("secrets.");
    expect(occurrenceCount(workflow, "timeout-minutes:")).toBeGreaterThanOrEqual(7);
    expect(occurrenceCount(workflow, "cache: pnpm")).toBe(3);
    expect(occurrenceCount(workflow, "pnpm install --frozen-lockfile")).toBe(3);
    expect(occurrenceCount(workflow, "node scripts/redact-ci-test-artifacts.mjs reports")).toBe(3);
    expect(occurrenceCount(workflow, "actions/upload-artifact@v4")).toBe(3);
    expect(workflow).toContain("if: failure() && steps.redact-unit.outcome == 'success'");
    expect(workflow).toContain("if: failure() && steps.redact-platform.outcome == 'success'");
    expect(workflow).toContain("if: failure() && steps.redact-packaged-smoke.outcome == 'success'");
    expect(desktopSmokeWorkflow).not.toContain("windows-latest");

    expect(packageJson.scripts["smoke:packaged:win"]).toBe("node scripts/verify-packaged-app.mjs");
    expect(packageJson.scripts["smoke:packaged:win"]).not.toMatch(/^\s*[A-Z][A-Z0-9_]*=/);
    expect(packagedVerifier).toContain("spawnManagedProcess");
    expect(packagedVerifier).toContain('tree.terminate("packaged startup smoke timeout")');
    expect(packagedVerifier).toContain('tree.terminate("packaged startup smoke early exit")');
    expect(packagedVerifier).toContain('tree.terminate("packaged startup smoke complete")');
    expect(packagedVerifier).toContain('termination.outcome === "already_exited"');
    expect(packagedVerifier).toContain("managedProcessTreeTerminated: true");
    expect(packagedVerifier).not.toContain("normalProcessExit");
    expect(packagedVerifier).toContain('child.once("close"');
    expect(packagedVerifier).not.toContain("await tree.exited");
    expect(packagedVerifier).not.toContain('child.kill("SIGTERM")');
    expect(packagedVerifier).toContain("buildSmokeEnvironment(smokeHome, smokeUserData)");
    expect(packagedVerifier).toContain("maxCapturedOutputBytes");
    expect(packagedVerifier).toContain("redactCiText");
    expect(packagedVerifier).not.toContain("...process.env");
    expect(packagedVerifier).not.toContain("process.stdout.write(text)");
    expect(packagedVerifier).not.toContain("process.stderr.write(text)");
    const packagedStartupSection = packagedStartupSmoke.split("function wait(ms: number)")[0] ?? "";
    expect(packagedStartupSection).toContain('document.getElementById("root")');
    expect(packagedStartupSection).toContain('typeof runtimeBridge.listProjects !== "function"');
    expect(packagedStartupSection).not.toMatch(/[\u3400-\u9fff]/);
    const startupMainSection = desktopMain.split("if (isStartupSmoke)")[1]?.split("return;")[0];
    expect(startupMainSection).toContain("runPackagedStartupSmoke(window)");
    expect(startupMainSection).not.toContain("app.exit(0)");
    expect(redactor).toContain("descriptor|endpoint|hostname|password|secret|token");
    expect(redactor).toContain("<redacted-user-path>");
  });

  it(
    "forwards package-script worker and JUnit options to Vitest",
    async () => {
      const reportDirectory = await mkdtemp(join(tmpdir(), "planweave-ci-junit-options-"));
      const reportPath = resolve(reportDirectory, "unit.xml");
      try {
        await execFileAsync(
          "pnpm",
          [
            "test:unit",
            "packages/runtime/src/__tests__/runnerInteractionContract.test.ts",
            "--maxWorkers=1",
            "--reporter=default",
            "--reporter=junit",
            `--outputFile.junit=${reportPath}`
          ],
          { cwd: repoRoot, env: process.env }
        );

        const report = await readFile(reportPath, "utf8");
        expect(report).toContain("<testsuites");
        expect(report).toContain("runnerInteractionContract.test.ts");
      } finally {
        await rm(reportDirectory, { recursive: true, force: true });
      }
    },
    junitWorkflowVerificationTimeoutMs
  );

  it("anchors packaged smoke reports and redacts diagnostics before exposure", async () => {
    const reportDirectory = await mkdtemp(join(tmpdir(), "planweave-packaged-report-path-"));
    const verifierPath = resolve(desktopRoot, "scripts/verify-packaged-app.mjs");
    const relativeReportPath = resolve(reportDirectory, "relative.json");
    const absoluteReportPath = resolve(reportDirectory, "absolute.json");
    const invokeVerifier = async (reportPath: string, platform = "unsupported-test-platform") => {
      const result = await execFileAsync(process.execPath, [verifierPath], {
        cwd: desktopRoot,
        env: {
          ...process.env,
          PLANWEAVE_PACKAGED_PLATFORM: platform,
          PLANWEAVE_CI_REPORT_PATH: reportPath
        }
      }).catch((error) => error as { stderr?: string });
      const stderr = result.stderr ?? "";
      expect(stderr).toContain("Unsupported packaged app platform");
      return stderr;
    };

    try {
      await invokeVerifier(relative(repoRoot, relativeReportPath));
      await invokeVerifier(absoluteReportPath);

      for (const reportPath of [relativeReportPath, absoluteReportPath]) {
        expect(JSON.parse(await readFile(reportPath, "utf8"))).toMatchObject({
          schemaVersion: 1,
          platform: "unsupported-test-platform",
          status: "failed",
          failedStage: "resolve-packaged-app"
        });
      }

      const secret = "packaged-smoke-secret";
      const stderr = await invokeVerifier(absoluteReportPath, `token=${secret}`);
      const redactedReport = await readFile(absoluteReportPath, "utf8");
      expect(stderr).toContain("token=[REDACTED]");
      expect(stderr).not.toContain(secret);
      expect(redactedReport).toContain("[REDACTED]");
      expect(redactedReport).not.toContain(secret);

      const workflow = await readFile(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8");
      expect(workflow).toContain("PLANWEAVE_CI_REPORT_PATH: reports/windows-packaged-smoke.json");
      expect(workflow).toContain("path: reports");
    } finally {
      await rm(reportDirectory, { recursive: true, force: true });
    }
  });

  it("keeps real cross-process ACP coverage in the platform suite", async () => {
    const suiteManifest = JSON.parse(
      await readFile(resolve(repoRoot, "vitest.suites.json"), "utf8")
    ) as {
      groups: Array<{ root: string; unit: string[]; platform: string[] }>;
    };
    const runtime = suiteManifest.groups.find(
      (group) => group.root === "packages/runtime/src/__tests__"
    );
    const cli = suiteManifest.groups.find((group) => group.root === "packages/cli/src/__tests__");

    expect(runtime?.platform).toContain("agentRunControlTwoProcess.test.ts");
    expect(runtime?.unit).not.toContain("agentRunControlTwoProcess.test.ts");
    expect(cli?.platform).toContain("acpCliE2E.test.ts");
  });

  it("redacts credentials, descriptors, and user paths before CI artifact upload", async () => {
    const reportDirectory = await mkdtemp(join(tmpdir(), "planweave-ci-report-redaction-"));
    const reportPath = resolve(reportDirectory, "failure.json");
    try {
      await writeFile(
        reportPath,
        JSON.stringify({
          token: "test-token-value",
          descriptor: "private-pipe-descriptor",
          unixPath: "/Users/example/private/failure.xml",
          windowsPath: "C:\\Users\\example\\private\\failure.xml"
        }),
        "utf8"
      );
      await writeFile(
        resolve(reportDirectory, "failure.xml"),
        '<testsuite hostname="private-builder.local" token="test-xml-token" />',
        "utf8"
      );
      await execFileAsync(
        process.execPath,
        [resolve(repoRoot, "scripts/redact-ci-test-artifacts.mjs"), reportDirectory],
        { cwd: repoRoot }
      );
      const redactedReport = await readFile(reportPath, "utf8");

      expect(redactedReport).not.toContain("test-token-value");
      expect(redactedReport).not.toContain("private-pipe-descriptor");
      expect(redactedReport).not.toContain("/Users/example");
      expect(redactedReport).not.toContain("C:\\Users\\example");
      expect(redactedReport).toContain("[REDACTED]");
      expect(redactedReport).toContain("<redacted-user-path>");
      const redactedXml = await readFile(resolve(reportDirectory, "failure.xml"), "utf8");
      expect(redactedXml).not.toContain("private-builder.local");
      expect(redactedXml).not.toContain("test-xml-token");
    } finally {
      await rm(reportDirectory, { recursive: true, force: true });
    }
  });
});
