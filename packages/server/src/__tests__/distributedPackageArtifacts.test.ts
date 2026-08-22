import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PLANWEAVE_COMPATIBILITY_BOUNDS,
  agentHostProtocolVersion,
  assertAgentHostProtocolCompatible,
  assertGracefulPackageDowngrade,
  assertMatchingPackageMajors
} from "@planweave-ai/agent-host-protocol";
import { serverPackageVersion } from "../packageInfo.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const rootLicense = readFileSync(join(repoRoot, "LICENSE"), "utf8");

type PackageJson = {
  name: string;
  version: string;
  private?: boolean;
  engines?: { node?: string };
  bin?: Record<string, string>;
  files?: string[];
  publishConfig?: { access?: string };
  license?: string;
  sideEffects?: boolean;
  homepage?: string;
  repository?: { type?: string; url?: string; directory?: string };
  bugs?: { url?: string };
  dependencies?: Record<string, string>;
  exports?: Record<string, unknown>;
  main?: string;
  types?: string;
  scripts?: Record<string, string>;
};

function readPackageJson(relativePath: string): PackageJson {
  return JSON.parse(readFileSync(join(repoRoot, relativePath), "utf8")) as PackageJson;
}

function expectPublishableMetadata(pkg: PackageJson, directory: string): void {
  expect(pkg.engines?.node).toBe(">=22.13");
  expect(pkg.license).toBe("MIT");
  expect(pkg.files).toEqual(["dist", "LICENSE"]);
  expect(pkg.publishConfig?.access).toBe("public");
  expect(pkg.private).not.toBe(true);
  expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
  expect(pkg.homepage).toBe("https://github.com/GaosCode/PlanWeave#readme");
  expect(pkg.bugs?.url).toBe("https://github.com/GaosCode/PlanWeave/issues");
  expect(pkg.repository).toEqual({
    type: "git",
    url: "git+https://github.com/GaosCode/PlanWeave.git",
    directory
  });
  expect(pkg.sideEffects).toBe(false);
  expect(existsSync(join(repoRoot, directory, "LICENSE"))).toBe(true);
  expect(readFileSync(join(repoRoot, directory, "LICENSE"), "utf8")).toBe(rootLicense);
}

describe("distributed package artifact contracts", () => {
  it("keeps install evidence portable without local absolute paths", () => {
    const smokeScript = readFileSync(
      join(repoRoot, "scripts/distributed-package-install-smoke.mjs"),
      "utf8"
    );

    expect(smokeScript).toContain('cwd: "<redacted>"');
    expect(smokeScript).toContain("fileName: basename(artifact.path)");
    expect(smokeScript).toContain('root: "<redacted>"');
    expect(smokeScript).not.toContain("report.packages.push(artifact)");
    expect(smokeScript).toContain('replaceAll(repoRoot, "<repo-root>")');
    expect(smokeScript).toContain('replaceAll(workRoot, "<temporary-root>")');
    expect(smokeScript).toContain("platform: process.platform");
    expect(smokeScript).toContain("arch: process.arch");
    expect(smokeScript).toContain('policy: "zero-vulnerabilities"');
    expect(smokeScript).toContain('auditLevel: "info"');
    expect(smokeScript).toContain('"--audit-level=info"');
    expect(smokeScript).not.toContain('["content/authority", "contentAuthority"]');
  });

  it("pins engines, bins, licenses, and publish metadata for shippable packages", () => {
    const protocol = readPackageJson("packages/agent-host-protocol/package.json");
    const contracts = readPackageJson("packages/collaboration-protocol/package.json");
    const runtime = readPackageJson("packages/runtime/package.json");
    const server = readPackageJson("packages/server/package.json");
    const host = readPackageJson("packages/agent-host/package.json");
    const cli = readPackageJson("packages/cli/package.json");
    const mcp = readPackageJson("packages/mcp/package.json");
    const desktop = readPackageJson("packages/desktop/package.json");
    const root = readPackageJson("package.json");

    expectPublishableMetadata(protocol, "packages/agent-host-protocol");
    expectPublishableMetadata(contracts, "packages/collaboration-protocol");
    expectPublishableMetadata(runtime, "packages/runtime");
    expectPublishableMetadata(server, "packages/server");
    expectPublishableMetadata(host, "packages/agent-host");
    expectPublishableMetadata(cli, "packages/cli");
    expectPublishableMetadata(mcp, "packages/mcp");

    expect(server.name).toBe("@planweave-ai/server");
    expect(host.name).toBe("@planweave-ai/agent-host");
    expect(server.bin?.["planweave-server"]).toBe("./dist/bin.js");
    expect(host.bin?.["planweave-agent-host"]).toBe("./dist/bin.js");
    expect(cli.bin?.planweave).toBe("./dist/index.js");
    expect(mcp.bin?.["planweave-mcp"]).toBe("./dist/index.js");
    expect(server.version).toBe(serverPackageVersion);
    expect(server.dependencies?.["@planweave-ai/agent-host-protocol"]).toBe("workspace:*");
    expect(host.dependencies?.["@planweave-ai/agent-host-protocol"]).toBe("workspace:*");
    expect(runtime.dependencies?.["@planweave-ai/agent-host-protocol"]).toBe("workspace:*");
    expect(contracts.dependencies?.["@planweave-ai/agent-host-protocol"]).toBe("workspace:*");
    expect(contracts.main).toBeUndefined();
    expect(contracts.types).toBeUndefined();
    expect(contracts.exports?.["."]).toBeUndefined();
    expect(contracts.exports?.["./content/authority"]).toBeUndefined();
    expect(contracts.exports?.["./core/primitives"]).toEqual({
      types: "./dist/primitives.d.ts",
      import: "./dist/primitives.js"
    });
    expect(contracts.exports?.["./fixtures/collaboration"]).toEqual({
      types: "./dist/fixtures/collaboration.d.ts",
      import: "./dist/fixtures/collaboration.js"
    });
    expect(server.dependencies?.["@planweave-ai/collaboration-protocol"]).toBe("workspace:*");
    expect(agentHostProtocolVersion).toBe(1);

    // Desktop is Electron-distributed, never an npm library publish target.
    expect(desktop.private).toBe(true);
    expect(desktop.publishConfig).toBeUndefined();
    expect(desktop.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(desktop.license).toBe("MIT");
    expect(existsSync(join(repoRoot, "packages/desktop/LICENSE"))).toBe(true);
    expect(readFileSync(join(repoRoot, "packages/desktop/LICENSE"), "utf8")).toBe(rootLicense);

    // Root remains private monorepo shell.
    expect(root.private).toBe(true);
    const publicPackageOrder = [
      "@planweave-ai/agent-host-protocol",
      "@planweave-ai/collaboration-protocol",
      "@planweave-ai/runtime",
      "@planweave-ai/mcp",
      "@planweave-ai/server",
      "@planweave-ai/agent-host",
      "@planweave-ai/cli"
    ];
    for (const scriptName of ["pack:npm", "publish:npm"]) {
      const script = root.scripts?.[scriptName] ?? "";
      let previousIndex = -1;
      for (const packageName of publicPackageOrder) {
        const packageIndex = script.indexOf(`--filter ${packageName} `);
        expect(packageIndex).toBeGreaterThan(previousIndex);
        previousIndex = packageIndex;
      }
    }
    expect(root.scripts?.["publish:npm"]).toContain("pnpm -r");
    expect(root.scripts?.["publish:npm"]).toContain("--access public");
    expect(root.scripts?.["publish:npm"]).toContain("--no-git-checks");
    expect(root.scripts?.["publish:distributed"]).toBeUndefined();
  });

  it("keeps npm version targets aligned with the standard publish lane", () => {
    const syncVersionScript = readFileSync(
      join(repoRoot, "scripts/sync-version-metadata.mjs"),
      "utf8"
    );

    expect(syncVersionScript).toMatch(
      /"--npm": \[\s*"agent-host-protocol",\s*"collaboration-protocol",\s*"runtime",\s*"mcp",\s*"server",\s*"agent-host",\s*"cli"\s*\]/
    );
    expect(syncVersionScript).toContain("--npm       all seven public npm package.json files");
  });

  it("keeps schema-only packages free of implementation dependencies", () => {
    const protocol = readPackageJson("packages/agent-host-protocol/package.json");
    const contracts = readPackageJson("packages/collaboration-protocol/package.json");
    expect(Object.keys(protocol.dependencies ?? {}).sort()).toEqual(["zod"]);
    expect(Object.keys(contracts.dependencies ?? {}).sort()).toEqual([
      "@planweave-ai/agent-host-protocol",
      "zod"
    ]);
    for (const name of [
      "electron",
      "ws",
      "better-sqlite3",
      "sqlite3",
      "@planweave-ai/runtime",
      "@planweave-ai/server",
      "@planweave-ai/agent-host"
    ]) {
      expect(protocol.dependencies?.[name]).toBeUndefined();
      expect(contracts.dependencies?.[name]).toBeUndefined();
    }
  });

  it("keeps Server/Host free of native better-sqlite3 package dependencies", () => {
    const server = readPackageJson("packages/server/package.json");
    const host = readPackageJson("packages/agent-host/package.json");
    const forbidden = ["better-sqlite3", "sqlite3", "node-gyp-build"];
    for (const name of forbidden) {
      expect(server.dependencies?.[name]).toBeUndefined();
      expect(host.dependencies?.[name]).toBeUndefined();
    }
  });

  it("exports explicit protocol and package-major rejection helpers", () => {
    expect(PLANWEAVE_COMPATIBILITY_BOUNDS.agentHostProtocolVersion).toBe(1);
    expect(assertAgentHostProtocolCompatible(1)).toEqual({ ok: true });
    expect(assertAgentHostProtocolCompatible(2)).toMatchObject({
      ok: false,
      code: "protocol_version_incompatible"
    });
    expect(
      assertMatchingPackageMajors({
        server: "0.3.0",
        agentHost: "0.3.1",
        protocol: "0.3.2"
      })
    ).toEqual({ ok: true });
    expect(
      assertMatchingPackageMajors({
        server: "0.3.0",
        agentHost: "1.0.0"
      })
    ).toMatchObject({ ok: false, code: "package_major_mismatch" });
    expect(assertGracefulPackageDowngrade({ fromVersion: "0.3.2", toVersion: "0.3.0" })).toEqual({
      ok: true
    });
    expect(
      assertGracefulPackageDowngrade({ fromVersion: "1.0.0", toVersion: "0.9.0" })
    ).toMatchObject({ ok: false, code: "package_downgrade_major_forbidden" });
  });
});
