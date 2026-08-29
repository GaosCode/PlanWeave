import { createServer, type Server as HttpServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PlanPackageManifest } from "@planweave-ai/runtime";
import {
  basicManifest,
  createTestWorkspace,
  writePromptFiles
} from "../../../../runtime/src/__tests__/promptTestHelpers.js";
import { writeJsonFile } from "../../../../runtime/src/json.js";
import {
  canonicalProjectCanvasNode,
  loadProjectGraph,
  projectCanvasWorkspace,
  writeProjectGraph
} from "../../../../runtime/src/projectGraph/index.js";
import { parseServerConfig } from "../../config.js";
import { hashOperatorToken } from "../../operatorAuth.js";
import {
  createDistributedServerComposition,
  type DistributedServerComposition
} from "../../serverComposition.js";
import { openServerDatabase } from "../../sqlite.js";
import { AuthorityRepository } from "../../work/authorityRepository.js";
import { ContentVersionRepository } from "../../canvas/contentVersionRepository.js";
import { readStableCanvasRuntimeContentTarget } from "../../canvas/contentFingerprint.js";

export const adminToken = `pw_operator_${"A".repeat(43)}`;
export const projectToken = `pw_operator_${"B".repeat(43)}`;

export function remoteManifest(): PlanPackageManifest {
  const manifest = basicManifest();
  manifest.execution.defaultExecutor = "codex-acp";
  manifest.executors = {
    "codex-acp": { adapter: "agent", agent: "codex", runner: { transport: "acp" } }
  };
  return manifest;
}

export function jsonHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, "content-type": "application/json" };
}

export async function configureAutomaticExecutionTarget(input: {
  databasePath: string;
  workspaceId: string;
  projectId: string;
  canvasId: string;
  blockRef: string;
}): Promise<number> {
  const database = await openServerDatabase(input.databasePath, 5_000);
  try {
    return new AuthorityRepository(database).applyExecutionTarget({
      mutation: {
        schemaVersion: "execution-target/v1",
        scope: {
          kind: "block",
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          canvasId: input.canvasId,
          blockRef: input.blockRef
        },
        target: { kind: "automatic_host" },
        expectedRevision: 0
      },
      actor: { kind: "system", id: "server-composition-test" }
    }).revision;
  } finally {
    database.close();
  }
}

export async function readDispatchAuthority(input: {
  databasePath: string;
  workspaceId: string;
  projectId: string;
  canvasId: string;
  blockRef: string;
}) {
  const database = await openServerDatabase(input.databasePath, 5_000);
  try {
    const content = readStableCanvasRuntimeContentTarget(new ContentVersionRepository(database), {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      canvasId: input.canvasId
    });
    const revisions = new AuthorityRepository(database).currentRevisions({
      kind: "block",
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      canvasId: input.canvasId,
      blockRef: input.blockRef
    });
    return {
      expectedResponsibilityRevision: revisions.responsibilityRevision,
      expectedReviewerRevision: revisions.reviewerRevision,
      executionTargetRevision: revisions.executionTargetRevision,
      contentRevision: String(content.revision),
      graphFingerprint: content.graphFingerprint
    };
  } finally {
    database.close();
  }
}

export async function addSecondaryCanvas(root: string): Promise<void> {
  const loaded = await loadProjectGraph(root);
  const secondaryCanvas = canonicalProjectCanvasNode({
    id: "secondary",
    title: "Secondary canvas"
  });
  const secondaryWorkspace = projectCanvasWorkspace(loaded.workspace, secondaryCanvas);
  const manifest = remoteManifest();
  await mkdir(secondaryWorkspace.packageDir, { recursive: true });
  await writeJsonFile(secondaryWorkspace.manifestFile, manifest);
  await writePromptFiles(secondaryWorkspace.packageDir, manifest);
  await writeFile(secondaryWorkspace.stateFile, await readFile(loaded.workspace.stateFile));
  await mkdir(secondaryWorkspace.resultsDir, { recursive: true });
  await mkdir(join(loaded.workspace.workspaceRoot, "canvases", "undeclared"), {
    recursive: true
  });
  await writeProjectGraph(loaded.workspace, {
    version: "plan-project/v1",
    canvases: [
      canonicalProjectCanvasNode({ id: "default", title: "Default canvas" }),
      secondaryCanvas
    ],
    edges: [],
    crossTaskEdges: []
  });
}

export async function setupServerCompositionFixture(input: {
  directories: string[];
  httpServers: HttpServer[];
  compositions: DistributedServerComposition[];
}) {
  const workspace = await createTestWorkspace(remoteManifest());
  input.directories.push(workspace.home, workspace.root);
  const httpServer = createServer();
  input.httpServers.push(httpServer);
  const dataDirectory = join(workspace.root, "server-data");
  const projectId = workspace.init.workspace.id;
  const workspaceId = "workspace-server";
  const config = parseServerConfig({
    version: "server-config/v1",
    bind: { host: "127.0.0.1", port: 7_443 },
    publicUrl: "http://127.0.0.1:7443",
    allowInsecureDevelopment: true,
    dataDirectory,
    trustedProjects: [{ workspaceId, projectId, canvasId: "default", projectRoot: workspace.root }],
    operatorCredentials: [
      {
        operatorId: "admin",
        tokenSha256: hashOperatorToken(adminToken),
        projectIds: [],
        serverAdmin: true
      },
      {
        operatorId: "project-operator",
        tokenSha256: hashOperatorToken(projectToken),
        projectIds: [projectId]
      }
    ]
  });
  const composition = await createDistributedServerComposition({ httpServer, config });
  input.compositions.push(composition);
  const executionTargetRevision = await configureAutomaticExecutionTarget({
    databasePath: config.databasePath,
    workspaceId,
    projectId,
    canvasId: "default",
    blockRef: "T-001#B-001"
  });
  const dispatchAuthority = await readDispatchAuthority({
    databasePath: config.databasePath,
    workspaceId,
    projectId,
    canvasId: "default",
    blockRef: "T-001#B-001"
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("Expected HTTP address");
  return {
    composition,
    projectId,
    workspaceId,
    databasePath: config.databasePath,
    origin: `http://127.0.0.1:${address.port}`,
    executionTargetRevision,
    dispatchAuthority
  };
}
