import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("desktop renderer DOM boundaries", () => {
  it("exposes a repository check for direct DOM API usage", async () => {
    const packageJson = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["check:dom-boundaries"]).toBe("node scripts/check-renderer-dom-boundaries.mjs");
  });

  it("keeps production renderer DOM queries inside approved boundary files", async () => {
    const result = await execFileAsync(process.execPath, [resolve(repoRoot, "scripts/check-renderer-dom-boundaries.mjs")], {
      cwd: repoRoot
    });

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("DOM boundary check passed");
  });

  it("rejects production renderer DOM text and class state reads", async () => {
    const fixtureDir = resolve(repoRoot, "packages/desktop/src/renderer/__dom-boundary-fixtures__");
    const fixturePath = resolve(fixtureDir, "DomStateReadViolation.tsx");
    await mkdir(fixtureDir, { recursive: true });
    await writeFile(
      fixturePath,
      [
        "export function DomStateReadViolation(element: HTMLElement) {",
        "  const blocked = element.textContent?.includes('Blocked');",
        "  const selected = element.classList.contains('selected');",
        "  return Boolean(blocked || selected);",
        "}",
        ""
      ].join("\n")
    );

    try {
      await expect(
        execFileAsync(process.execPath, [resolve(repoRoot, "scripts/check-renderer-dom-boundaries.mjs")], {
          cwd: repoRoot
        })
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("textContent")
      });
      await expect(
        execFileAsync(process.execPath, [resolve(repoRoot, "scripts/check-renderer-dom-boundaries.mjs")], {
          cwd: repoRoot
        })
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("classList")
      });
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });
});
