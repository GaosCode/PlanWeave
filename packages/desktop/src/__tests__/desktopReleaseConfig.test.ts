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
      build: { mac: Record<string, unknown> };
    };
    const { default: localConfig } = await loadConfig("electron-builder.local.cjs");

    for (const [name, command] of Object.entries(packageJson.scripts)) {
      if (name.startsWith("pack:") || name.startsWith("dist:")) {
        expect(command).toContain("--config electron-builder.local.cjs");
      }
    }
    expect(packageJson.build.mac).not.toHaveProperty("identity");
    expect(localConfig).toMatchObject({
      artifactName: expect.stringContaining("development-unsigned"),
      mac: { identity: null, forceCodeSigning: false },
      win: { forceCodeSigning: false, signExecutable: false }
    });
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
      stderr: expect.stringContaining("CSC_KEY_PASSWORD")
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

    expect(workflow).toContain("environment: desktop-release");
    expect(macPreflight).toBeGreaterThan(-1);
    expect(winPreflight).toBeGreaterThan(-1);
    expect(macPreflight).toBeLessThan(macBuild);
    expect(winPreflight).toBeLessThan(winBuild);
    expect(workflow).toContain("--config electron-builder.release.cjs");
    expect(workflow).toContain("secrets.WINDOWS_OV_PFX");
    expect(workflow).not.toContain("azureSignOptions");
  });
});
