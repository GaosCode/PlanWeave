import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const scriptPath = resolve(repoRoot, "packages/desktop/scripts/verify-release-assets.mjs");

type BuildConfig = {
  version: string;
  productName: string;
  artifactName: string;
  dmgArtifactName: string;
  targets: {
    linux: string[];
    mac: string[];
    win: string[];
  };
};

type VerifyAssetsReport = {
  actual: string[];
  expected: string[];
  missing: string[];
  extra: string[];
};

type ReleaseAssetsModule = {
  loadDesktopBuildConfig(path?: string): Promise<BuildConfig>;
  expectedReleaseAssets(config: BuildConfig, version: string): string[];
  verifyAssets(directory: string, expectedNames: string[], logger?: { log(message: string): void }): Promise<VerifyAssetsReport>;
};

async function loadReleaseAssetsModule() {
  return (await import(pathToFileURL(scriptPath).href)) as ReleaseAssetsModule;
}

async function createReleaseAssetDir(names: string[]) {
  const directory = await mkdtemp(resolve(tmpdir(), "planweave-release-assets-"));
  await mkdir(directory, { recursive: true });
  await Promise.all(names.map((name) => writeFile(resolve(directory, name), "")));
  return directory;
}

describe("release asset verification", () => {
  it("derives expected release assets from the desktop build config and release matrix", async () => {
    const releaseAssets = await loadReleaseAssetsModule();
    const config = await releaseAssets.loadDesktopBuildConfig();

    expect(releaseAssets.expectedReleaseAssets(config, config.version)).toEqual([
      `PlanWeave-${config.version}-linux-x86_64.AppImage`,
      `PlanWeave-${config.version}-linux-amd64.deb`,
      `PlanWeave-${config.version}-linux-x64.tar.gz`,
      `PlanWeave-${config.version}-universal.dmg`,
      `PlanWeave-${config.version}-mac-universal.zip`,
      `PlanWeave-${config.version}-win-x64.exe`,
      `PlanWeave-${config.version}-win-x64.zip`,
      "latest-linux.yml",
      "latest-mac.yml",
      "latest.yml"
    ]);
  });

  it("reports the concrete missing asset name", async () => {
    const releaseAssets = await loadReleaseAssetsModule();
    const config = await releaseAssets.loadDesktopBuildConfig();
    const expected = releaseAssets.expectedReleaseAssets(config, config.version);
    const missingAsset = `PlanWeave-${config.version}-linux-amd64.deb`;
    const directory = await createReleaseAssetDir(expected.filter((name) => name !== missingAsset));

    try {
      await expect(releaseAssets.verifyAssets(directory, expected, { log: () => undefined })).rejects.toThrow(missingAsset);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("allows extra assets while reporting actual and expected lists", async () => {
    const releaseAssets = await loadReleaseAssetsModule();
    const config = await releaseAssets.loadDesktopBuildConfig();
    const expected = releaseAssets.expectedReleaseAssets(config, config.version);
    const extraAsset = `PlanWeave-${config.version}-linux-x86_64.AppImage.blockmap`;
    const directory = await createReleaseAssetDir([...expected, extraAsset]);
    const logs: string[] = [];

    try {
      const report = await releaseAssets.verifyAssets(directory, expected, { log: (message) => logs.push(message) });

      expect(report.missing).toEqual([]);
      expect(report.extra).toEqual([extraAsset]);
      expect(logs.join("\n")).toContain("Actual release assets:");
      expect(logs.join("\n")).toContain("Expected release assets:");
      expect(logs.join("\n")).toContain(extraAsset);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a CLI version that does not match packages/desktop/package.json", async () => {
    await expect(execFileAsync(process.execPath, [scriptPath, "--dir", tmpdir(), "--version", "0.0.0"], { cwd: repoRoot })).rejects.toMatchObject({
      stderr: expect.stringContaining("Version mismatch")
    });
  });

  it("keeps the desktop release workflow wired to the manifest-driven verifier", async () => {
    const [workflowSource, packageSource] = await Promise.all([
      readFile(resolve(repoRoot, ".github/workflows/desktop-release.yml"), "utf8"),
      readFile(resolve(repoRoot, "packages/desktop/package.json"), "utf8")
    ]);
    const verifyAssetsStart = workflowSource.indexOf("  verify-assets:");
    const verifyAssetsEnd = workflowSource.indexOf("\n  publish:", verifyAssetsStart);
    const verifyAssetsJob = workflowSource.slice(verifyAssetsStart, verifyAssetsEnd);
    const desktopPackage = JSON.parse(packageSource) as { scripts?: Record<string, string> };

    expect(desktopPackage.scripts?.["verify:release-assets"]).toBe("node scripts/verify-release-assets.mjs");
    expect(verifyAssetsJob).toContain("uses: actions/checkout@v4");
    expect(verifyAssetsJob).toContain('node packages/desktop/scripts/verify-release-assets.mjs --dir desktop-artifacts --version "${VERSION}"');
    expect(verifyAssetsJob).not.toContain("required_patterns=");
    expect(verifyAssetsJob).not.toContain("PlanWeave-${VERSION}-linux-x86_64.AppImage");
  });
});
