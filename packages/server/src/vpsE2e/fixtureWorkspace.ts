import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capturePackageSnapshot,
  initWorkspace,
  loadPlanGraphPackage,
  writeProjectGraph,
  type PlanPackageManifest
} from "@planweave-ai/runtime";

/**
 * Disposable Plan Package + trusted project root for local-tls-fixture.
 * Uses public runtime APIs only (no test-helper imports).
 */
export function remoteAcpFixtureManifest(): PlanPackageManifest {
  return {
    version: "plan-package/v1",
    project: {
      title: "VPS e2e fixture",
      description: "Bounded remote ACP fixture for authenticated VPS/local-TLS e2e."
    },
    execution: {
      parallel: { enabled: false, maxConcurrent: 1 },
      defaultExecutor: "codex-acp"
    },
    review: {
      maxFeedbackCycles: 1,
      completionPolicy: "strict"
    },
    executors: {
      "codex-acp": {
        adapter: "agent",
        agent: "codex",
        runner: { transport: "acp" }
      }
    },
    nodes: [
      {
        id: "T-001",
        type: "task",
        title: "Fixture task",
        prompt: "nodes/T-001/prompt.md",
        acceptance: ["Fixture block completes under Host-local mock ACP."],
        blocks: [
          {
            id: "B-001",
            type: "implementation",
            title: "Bounded fixture implementation",
            prompt: "nodes/T-001/blocks/B-001.prompt.md",
            depends_on: [],
            requirements: { capabilities: ["acp.codex"] }
          },
          {
            id: "R-001",
            type: "review",
            title: "Fixture review",
            prompt: "nodes/T-001/blocks/R-001.prompt.md",
            depends_on: ["B-001"],
            review: { required: true, maxFeedbackCycles: 1, hook: null }
          }
        ]
      }
    ],
    edges: []
  };
}

async function writePromptFiles(packageDir: string, manifest: PlanPackageManifest): Promise<void> {
  for (const node of manifest.nodes) {
    if (node.type !== "task") continue;
    await mkdir(join(packageDir, "nodes", node.id, "blocks"), { recursive: true });
    await writeFile(join(packageDir, node.prompt), `# ${node.id} task prompt\n`, "utf8");
    for (const block of node.blocks) {
      await writeFile(
        join(packageDir, block.prompt),
        `# ${node.id}#${block.id} bounded fixture prompt — no secrets, no network side effects.\n`,
        "utf8"
      );
    }
  }
}

export type FixtureWorkspace = {
  home: string;
  root: string;
  projectId: string;
  sourceRevision: string;
  graphFingerprint: string;
  ownedRoots: string[];
};

export async function createFixtureWorkspace(): Promise<FixtureWorkspace> {
  const home = await mkdtemp(join(tmpdir(), "planweave-vps-e2e-home-"));
  const root = await mkdtemp(join(tmpdir(), "planweave-vps-e2e-project-"));
  process.env.PLANWEAVE_HOME = home;
  process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE = join(home, "desktop-settings.json");

  const init = await initWorkspace({ projectRoot: root });
  const manifest = remoteAcpFixtureManifest();
  await writeFile(init.workspace.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writePromptFiles(init.workspace.packageDir, manifest);
  await writeProjectGraph(init.workspace, {
    version: "plan-project/v1",
    canvases: [
      {
        id: "default",
        type: "canvas",
        title: manifest.project.title,
        packageDir: "canvases/default/package",
        stateFile: "canvases/default/state.json",
        resultsDir: "canvases/default/results"
      }
    ],
    edges: [],
    crossTaskEdges: []
  });

  const loaded = await loadPlanGraphPackage(init.workspace);
  const captured = await capturePackageSnapshot({ projectRoot: init.workspace });
  return {
    home,
    root,
    projectId: init.workspace.id,
    sourceRevision: captured.snapshot.sourceRevision,
    graphFingerprint: loaded.graph.packageFingerprint,
    ownedRoots: [home, root]
  };
}
