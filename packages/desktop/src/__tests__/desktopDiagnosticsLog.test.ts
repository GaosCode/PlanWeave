import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  desktopDiagnosticsLogPath,
  ensureDesktopDiagnosticsLog,
  recordDesktopError
} from "../main/desktopDiagnosticsLog.js";
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
it("records failure causes without credentials and rotates bounded logs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pw-diagnostics-"));
  roots.push(root);
  vi.stubEnv("PLANWEAVE_HOME", root);
  const path = await ensureDesktopDiagnosticsLog();
  expect(path).toBe(desktopDiagnosticsLogPath());
  await recordDesktopError(
    "workspace.select",
    new Error("fetch failed", { cause: new Error("Authorization: Bearer pw_hdev_SECRET123") })
  );
  const first = await readFile(path, "utf8");
  expect(JSON.parse(first).operation).toBe("workspace.select");
  expect(first).toContain("fetch failed");
  expect(first).not.toContain("SECRET123");
  await writeFile(path, "x".repeat(2 * 1024 * 1024));
  await recordDesktopError("workspace.retry", new Error("offline"));
  expect((await readFile(`${path}.previous`, "utf8")).length).toBe(2 * 1024 * 1024);
  expect(JSON.parse(await readFile(path, "utf8")).operation).toBe("workspace.retry");
});
