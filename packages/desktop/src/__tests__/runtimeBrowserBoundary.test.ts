import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const boundaryScript = resolve(repoRoot, "scripts/check-runtime-browser-boundary.mjs");

describe("runtime browser boundary", () => {
  it("keeps the browser entry and renderer runtime imports browser-safe", async () => {
    const result = await execFileAsync(process.execPath, [boundaryScript], { cwd: repoRoot });

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Runtime browser boundary check passed");
  });

  it("rejects transitive Node built-ins", async () => {
    const fixtureDir = await mkdtemp(resolve(tmpdir(), "planweave-browser-boundary-"));
    const runtimeEntry = resolve(fixtureDir, "browser.ts");
    const runtimeDependency = resolve(fixtureDir, "dependency.ts");
    const rendererDir = resolve(fixtureDir, "renderer");
    await mkdir(rendererDir);
    await writeFile(runtimeEntry, 'export { value } from "./dependency.js";\n');
    await writeFile(runtimeDependency, 'export const value = import("node:path");\n');
    await writeFile(resolve(rendererDir, "empty.ts"), "export {};\n");

    try {
      await expect(
        execFileAsync(process.execPath, [boundaryScript], {
          cwd: repoRoot,
          env: {
            ...process.env,
            PLANWEAVE_BROWSER_BOUNDARY_RUNTIME_ENTRY: runtimeEntry,
            PLANWEAVE_BROWSER_BOUNDARY_RENDERER_SRC: rendererDir
          }
        })
      ).rejects.toMatchObject({ stderr: expect.stringContaining("node:path") });
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  it("rejects runtime packages outside the browser-safe allowlist", async () => {
    const fixtureDir = await mkdtemp(resolve(tmpdir(), "planweave-browser-package-boundary-"));
    const runtimeEntry = resolve(fixtureDir, "browser.ts");
    const rendererDir = resolve(fixtureDir, "renderer");
    await mkdir(rendererDir);
    await writeFile(runtimeEntry, 'export { value } from "server-only-package";\n');
    await writeFile(resolve(rendererDir, "empty.ts"), "export {};\n");

    try {
      await expect(
        execFileAsync(process.execPath, [boundaryScript], {
          cwd: repoRoot,
          env: {
            ...process.env,
            PLANWEAVE_BROWSER_BOUNDARY_RUNTIME_ENTRY: runtimeEntry,
            PLANWEAVE_BROWSER_BOUNDARY_RENDERER_SRC: rendererDir
          }
        })
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("outside the browser-safe allowlist")
      });
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  it("rejects renderer value imports from the Node runtime entry", async () => {
    const fixtureDir = await mkdtemp(resolve(tmpdir(), "planweave-renderer-boundary-"));
    const runtimeEntry = resolve(fixtureDir, "browser.ts");
    const rendererDir = resolve(fixtureDir, "renderer");
    await mkdir(rendererDir);
    await writeFile(runtimeEntry, "export const value = 1;\n");
    await writeFile(
      resolve(rendererDir, "violation.ts"),
      'import { canvasIdSchema } from "@planweave-ai/runtime";\nvoid canvasIdSchema;\n'
    );

    try {
      await expect(
        execFileAsync(process.execPath, [boundaryScript], {
          cwd: repoRoot,
          env: {
            ...process.env,
            PLANWEAVE_BROWSER_BOUNDARY_RUNTIME_ENTRY: runtimeEntry,
            PLANWEAVE_BROWSER_BOUNDARY_RENDERER_SRC: rendererDir
          }
        })
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("uses runtime value import")
      });
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });
});
