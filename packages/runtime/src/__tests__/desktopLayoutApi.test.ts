import { stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDesktopLayout,
  resetDesktopLayout,
  resolveTaskCanvasWorkspace,
  saveDesktopLayout
} from "../desktop/index.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import type { PlanPackageManifest } from "../types.js";
import { validatePackage } from "../validatePackage.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: vi.fn(actual.stat)
  };
});

let actualFs: typeof import("node:fs/promises");

beforeEach(async () => {
  actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(stat).mockImplementation((path, options) => actualFs.stat(path, options));
});

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
  vi.restoreAllMocks();
});

function nodeIoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code} simulated`), { code });
}

describe("desktop layout API", () => {
  async function writeDefaultCanvasLayout(root: string, value: unknown): Promise<void> {
    const workspace = await resolveTaskCanvasWorkspace(root, "default");
    await writeJsonFile(join(workspace.workspaceRoot, "desktop", "layout.json"), value);
  }

  it("stores desktop layout outside the Plan Package", async () => {
    const { root, init } = await createTestWorkspace();

    expect(await getDesktopLayout(root)).toMatchObject({ nodes: [] });
    const saved = await saveDesktopLayout(root, {
      version: "desktop-layout/v1",
      projectId: "ignored",
      nodes: [{ nodeId: "T-001", x: 120, y: 240 }],
      updatedAt: new Date(0).toISOString()
    });

    expect(saved.projectId).toBe(init.workspace.id);
    expect(await getDesktopLayout(root)).toMatchObject({
      projectId: init.workspace.id,
      nodes: [{ nodeId: "T-001", x: 120, y: 240 }]
    });
    expect(await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile)).not.toHaveProperty(
      "layout"
    );
    expect(await resetDesktopLayout(root)).toMatchObject({
      projectId: init.workspace.id,
      nodes: []
    });
  });

  it("ignores stale layout node references and reports them during validation", async () => {
    const { root, init } = await createTestWorkspace();
    await writeDefaultCanvasLayout(root, {
      version: "desktop-layout/v1",
      projectId: init.workspace.id,
      nodes: [
        { nodeId: "T-001", x: 120, y: 240 },
        { nodeId: "T-STALE", x: 300, y: 420 }
      ],
      updatedAt: new Date(0).toISOString()
    });

    const layout = await getDesktopLayout(root);
    const report = await validatePackage({ projectRoot: root });

    expect(layout.nodes).toEqual([{ nodeId: "T-001", x: 120, y: 240 }]);
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "stale_layout_reference",
          path: "canvases/default/desktop/layout.json:T-STALE"
        })
      ])
    );
  });

  it("loads legacy object-map desktop layout files", async () => {
    const { root, init } = await createTestWorkspace();
    await writeDefaultCanvasLayout(root, {
      version: 1,
      nodes: {
        "T-001": {
          position: { x: 120, y: 240 },
          size: { width: 420, height: 300 }
        },
        "T-STALE": {
          position: { x: 300, y: 420 }
        }
      },
      viewport: { x: 0, y: 0, zoom: 0.75 }
    });

    const layout = await getDesktopLayout(root);
    const report = await validatePackage({ projectRoot: root });

    expect(layout).toMatchObject({
      version: "desktop-layout/v1",
      projectId: init.workspace.id,
      nodes: [{ nodeId: "T-001", x: 120, y: 240 }]
    });
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "legacy_layout_schema",
          path: "canvases/default/desktop/layout.json:nodes"
        }),
        expect.objectContaining({
          code: "stale_layout_reference",
          path: "canvases/default/desktop/layout.json:T-STALE"
        })
      ])
    );
  });

  it("does not return default layout when the layout file stat fails with EACCES", async () => {
    const { root } = await createTestWorkspace();
    const workspace = await resolveTaskCanvasWorkspace(root, "default");
    await writeDefaultCanvasLayout(root, {
      version: "desktop-layout/v1",
      projectId: workspace.id,
      nodes: [{ nodeId: "T-001", x: 120, y: 240 }],
      updatedAt: new Date(0).toISOString()
    });
    vi.mocked(stat).mockImplementation((path, options) => {
      if (path === join(workspace.workspaceRoot, "desktop", "layout.json")) {
        throw nodeIoError("EACCES");
      }
      return actualFs.stat(path, options);
    });

    await expect(getDesktopLayout(root)).rejects.toMatchObject({ code: "EACCES" });
  });

  it("reports layout_read_failed during validation when the layout file stat fails with EPERM", async () => {
    const { root } = await createTestWorkspace();
    const workspace = await resolveTaskCanvasWorkspace(root, "default");
    await writeDefaultCanvasLayout(root, {
      version: "desktop-layout/v1",
      projectId: workspace.id,
      nodes: [{ nodeId: "T-001", x: 120, y: 240 }],
      updatedAt: new Date(0).toISOString()
    });
    vi.mocked(stat).mockImplementation((path, options) => {
      if (path === join(workspace.workspaceRoot, "desktop", "layout.json")) {
        throw nodeIoError("EPERM");
      }
      return actualFs.stat(path, options);
    });

    const report = await validatePackage({ projectRoot: root });

    expect(report.ok).toBe(false);
    expect(report.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "layout_read_failed",
          message: expect.stringContaining("EPERM"),
          path: "canvases/default/desktop/layout.json"
        })
      ])
    );
  });

  it("reports invalid desktop layout schema during validation without blocking graph display fallback", async () => {
    const { root, init } = await createTestWorkspace();
    await writeDefaultCanvasLayout(root, {
      version: "desktop-layout/v1",
      projectId: init.workspace.id,
      nodes: [{ nodeId: "T-001", position: { x: 120, y: 240 } }],
      updatedAt: new Date(0).toISOString()
    });

    const layout = await getDesktopLayout(root);
    const report = await validatePackage({ projectRoot: root });

    expect(layout.nodes).toEqual([]);
    expect(report.ok).toBe(false);
    expect(report.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid_layout_schema",
          path: "canvases/default/desktop/layout.json:nodes.0"
        })
      ])
    );
  });
});
