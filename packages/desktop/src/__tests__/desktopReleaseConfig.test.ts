import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const desktopRoot = resolve(repoRoot, "packages/desktop");
const preflightPath = resolve(desktopRoot, "scripts/preflight-release-secrets.mjs");

async function loadConfig(name: string) {
  return (await import(resolve(desktopRoot, name))) as {
    default: Record<string, unknown>;
  };
}

describe("desktop release configuration", () => {
  it("keeps local pack and dist commands explicitly unsigned", async () => {
    const packageJson = JSON.parse(await readFile(resolve(desktopRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
      build: { mac: Record<string, unknown>; extraResources: Array<Record<string, unknown>> };
    };
    const { default: localConfig } = await loadConfig("electron-builder.local.cjs");

    for (const [name, command] of Object.entries(packageJson.scripts)) {
      if (name.startsWith("pack:") || name.startsWith("dist:")) {
        expect(command).toContain("--config electron-builder.local.cjs");
        expect(command).toContain("pnpm build:metadata:local");
      }
    }
    expect(packageJson.build.mac).not.toHaveProperty("identity");
    expect(localConfig).toMatchObject({
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
    const { default: releaseConfig } = await loadConfig("electron-builder.release.cjs");
    const win = releaseConfig.win as Record<string, unknown>;

    expect(win).toMatchObject({
      forceCodeSigning: true,
      signtoolOptions: {
        rfc3161TimeStampServer: "http://timestamp.digicert.com",
        signingHashAlgorithms: ["sha256"]
      }
    });
    expect(win).not.toHaveProperty("azureSignOptions");
    expect(JSON.stringify(releaseConfig)).not.toContain("certificatePassword");
  });

  it("enables hardened macOS signing and notarization with explicit entitlements", async () => {
    const { default: releaseConfig } = await loadConfig("electron-builder.release.cjs");

    expect(releaseConfig.mac).toEqual({
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
      expect(source).toContain("com.apple.security.cs.allow-unsigned-executable-memory");
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
    const workflow = await readFile(resolve(repoRoot, ".github/workflows/desktop-release.yml"), "utf8");
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
    expect(workflow).toContain("--channel release --signed-distribution ${{ matrix.signedDistribution }}");
    expect(workflow).toContain('signedDistribution: "true"');
    expect(workflow).toContain('signedDistribution: "false"');
    expect(workflow).toContain("--config electron-builder.release.cjs");
    expect(workflow).toContain("secrets.WINDOWS_OV_PFX");
    expect(workflow).not.toContain("azureSignOptions");
  });

  it("gates artifact upload on platform verification of the actual release installers", async () => {
    const workflow = await readFile(resolve(repoRoot, ".github/workflows/desktop-release.yml"), "utf8");
    const macVerification = workflow.indexOf("verify-macos-release.mjs");
    const windowsVerification = workflow.indexOf("verify-windows-release.ps1");
    const upload = workflow.indexOf("name: Upload desktop artifacts");
    const publishJob = workflow.indexOf("\n  publish:");

    expect(workflow).toContain("APPLE_API_KEY: ${{ secrets.APPLE_API_KEY }}");
    expect(workflow).toContain("packages/desktop/release/verification-*.txt");
    expect(macVerification).toBeGreaterThan(-1);
    expect(windowsVerification).toBeGreaterThan(-1);
    expect(macVerification).toBeLessThan(upload);
    expect(windowsVerification).toBeLessThan(upload);
    expect(workflow).toContain("needs: build");
    expect(workflow.slice(publishJob)).toContain("needs: verify-assets");
  });

  it("keeps platform verification fail closed and free of signing secrets", async () => {
    const [macVerifier, windowsVerifier] = await Promise.all([
      readFile(resolve(desktopRoot, "scripts/verify-macos-release.mjs"), "utf8"),
      readFile(resolve(desktopRoot, "scripts/verify-windows-release.ps1"), "utf8")
    ]);

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
});
