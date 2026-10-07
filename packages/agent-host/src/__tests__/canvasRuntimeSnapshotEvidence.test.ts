import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { capturePackageSnapshot, loadPlanGraphPackage } from "@planweave-ai/runtime";
import { createTestWorkspace } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { readCanvasRuntimeMaterializationEvidence } from "../runtime/canvasRuntimeService.js";
const gate = vi.hoisted(() => ({
  captured: undefined as (() => void) | undefined,
  beforeStatus: undefined as (() => Promise<void>) | undefined
}));
vi.mock("@planweave-ai/runtime", async (original) => {
  const actual = await original<typeof import("@planweave-ai/runtime")>();
  return {
    ...actual,
    capturePackageSnapshot: async (...args: Parameters<typeof actual.capturePackageSnapshot>) => {
      const value = await actual.capturePackageSnapshot(...args);
      gate.captured?.();
      return value;
    },
    readAuthorizedCanvasRuntimeStatus: async (
      ...args: Parameters<typeof actual.readAuthorizedCanvasRuntimeStatus>
    ) => {
      await gate.beforeStatus?.();
      return actual.readAuthorizedCanvasRuntimeStatus(...args);
    }
  };
});
const roots: string[] = [];
afterEach(async () => {
  gate.captured = gate.beforeStatus = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});
it("rejects a materialization receipt pairing captured A with actual status B", async () => {
  vi.stubEnv("PLANWEAVE_HOME", process.env.PLANWEAVE_HOME ?? "");
  vi.stubEnv("PLANWEAVE_DESKTOP_SETTINGS_FILE", process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE ?? "");
  const f = await createTestWorkspace();
  roots.push(f.root, f.home);
  const workspace = f.init.workspace;
  const snapshot = (await capturePackageSnapshot({ projectRoot: workspace })).snapshot;
  const before = await readFile(workspace.manifestFile, "utf8");
  const manifest = JSON.parse(before);
  manifest.project.title = "status version B";
  const changed = JSON.stringify(manifest);
  await writeFile(workspace.manifestFile, changed);
  const graphFingerprint = (await loadPlanGraphPackage(workspace)).graph.packageFingerprint;
  await writeFile(workspace.manifestFile, before);
  const canonicalDigest = "c".repeat(64);
  await writeFile(
    join(workspace.workspaceRoot, "authority-content-target.json"),
    JSON.stringify({
      revision: 1,
      content: {
        versionId: `version-${canonicalDigest}`,
        canonicalDigest,
        verification: "complete"
      },
      graphFingerprint
    })
  );
  const captured = new Promise<void>((resolve) => {
    gate.captured = resolve;
  });
  gate.beforeStatus = async () => {
    await captured;
    await writeFile(workspace.manifestFile, changed);
  };
  await expect(
    readCanvasRuntimeMaterializationEvidence(
      {
        scope: { workspaceId: "w", projectId: "p", canvasId: "default" },
        project: workspace,
        canvas: workspace
      },
      { sourceRevision: snapshot.sourceRevision, graphFingerprint }
    )
  ).rejects.toThrow("runtime_materialization_evidence_mismatch");
});
