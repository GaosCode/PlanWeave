import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capturePackageSnapshot,
  listRunSessions,
  loadPlanGraphPackage
} from "@planweave-ai/runtime";
import { describe, expect, it } from "vitest";
import {
  cliWorkflowTimeoutMs,
  repoRoot,
  runCli,
  runCliExpectFailure
} from "./support/cliTestHarness.js";
import {
  workspaceExecutionToken,
  WorkspaceExecutionHttpHarness,
  type WorkspaceExecutionRegistryCanvas,
  writeWorkspaceExecutionProfiles
} from "./support/workspaceExecutionHttpHarness.js";

async function remoteCanvasFixture(input: {
  registryCanvases: (localProjectId: string) => readonly WorkspaceExecutionRegistryCanvas[];
  registryPageSize?: number;
}) {
  const home = await mkdtemp(join(tmpdir(), "planweave-remote-canvas-binding-"));
  const env = {
    ...process.env,
    PLANWEAVE_HOME: home,
    PLANWEAVE_COLLABORATION_DEVICE_TOKEN: workspaceExecutionToken
  };
  const init = JSON.parse((await runCli(["init", "--project-graph", "--json"], env)).stdout);
  await cp(join(repoRoot, "examples/basic-plan-package/package"), init.workspace.packageDir, {
    recursive: true,
    force: true
  });
  const manifestPath = join(init.workspace.packageDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.execution.defaultExecutor = "missing-codex";
  manifest.executors = {
    "missing-codex": {
      adapter: "codex-exec",
      command: `planweave-missing-codex-${Date.now()}`,
      args: ["exec", "-"]
    }
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const captured = await capturePackageSnapshot({ projectRoot: init.workspace });
  const graph = await loadPlanGraphPackage(init.workspace);
  const server = new WorkspaceExecutionHttpHarness({
    sourceRevision: captured.snapshot.sourceRevision,
    graphFingerprint: graph.graph.packageFingerprint,
    dispatchMode: "action_required",
    registryCanvases: input.registryCanvases(init.workspace.id),
    registryPageSize: input.registryPageSize
  });
  const serverOrigin = await server.start();
  await writeWorkspaceExecutionProfiles({ home, serverOrigin });
  return { env, init, server };
}

function publishSource(localProjectId: string, localCanvasId = "default") {
  return { localProjectId, localCanvasId };
}

const remoteRunArgv = [
  "run",
  "--once",
  "--scope",
  "block",
  "--block",
  "T-001#B-001",
  "--canvas",
  "default",
  "--target",
  "remote",
  "--agent-endpoint",
  "endpoint-codex",
  "--connection-profile",
  "profile-1",
  "--event-format",
  "execution-v1"
];

const endpointListArgv = [
  "agent-endpoints",
  "list",
  "--canvas",
  "default",
  "--connection-profile",
  "profile-1",
  "--json"
];

describe("remote Canvas binding CLI", () => {
  it(
    "resolves the local Canvas selector to the unique authorized remote Canvas identity",
    async () => {
      const fixture = await remoteCanvasFixture({
        registryCanvases: (localProjectId) => [
          { canvasId: "remote-canvas-7", publishSource: publishSource(localProjectId) }
        ]
      });
      try {
        const result = await runCliExpectFailure(remoteRunArgv, fixture.env);
        expect(result).toMatchObject({ code: 7 });
        expect(fixture.server.authorityScopes).toContainEqual({
          kind: "block",
          workspaceId: "workspace-1",
          projectId: "project-1",
          canvasId: "remote-canvas-7",
          blockRef: "T-001#B-001"
        });
        expect(fixture.server.dispatchCount).toBe(1);
        const sessions = await listRunSessions(fixture.init.workspace);
        expect(sessions.diagnostics).toEqual([]);
        expect(sessions.sessions).toHaveLength(1);
        expect(sessions.sessions[0]).toMatchObject({
          canvasId: "default",
          scope: { kind: "block", blockRef: "T-001#B-001" },
          workspaceExecution: {
            binding: { canvasId: "remote-canvas-7" }
          }
        });
      } finally {
        await fixture.server.stop();
      }
    },
    cliWorkflowTimeoutMs
  );

  it(
    "continues registry pagination until the matching Canvas on the second page",
    async () => {
      const fixture = await remoteCanvasFixture({
        registryPageSize: 1,
        registryCanvases: (localProjectId) => [
          { canvasId: "unrelated-canvas", publishSource: publishSource("other-project") },
          { canvasId: "remote-canvas-page-2", publishSource: publishSource(localProjectId) }
        ]
      });
      try {
        const result = await runCliExpectFailure(remoteRunArgv, fixture.env);
        expect(result).toMatchObject({ code: 7 });
        expect(fixture.server.authorityScopes[0]).toMatchObject({
          canvasId: "remote-canvas-page-2"
        });
        expect(fixture.server.dispatchCount).toBe(1);
      } finally {
        await fixture.server.stop();
      }
    },
    cliWorkflowTimeoutMs
  );

  it(
    "fails closed when matching Canvas bindings are ambiguous across registry pages",
    async () => {
      const fixture = await remoteCanvasFixture({
        registryPageSize: 1,
        registryCanvases: (localProjectId) => [
          { canvasId: "remote-canvas-9", publishSource: publishSource(localProjectId) },
          { canvasId: "remote-canvas-10", publishSource: publishSource(localProjectId) }
        ]
      });
      try {
        const result = await runCliExpectFailure(remoteRunArgv, fixture.env);
        expect(result).toMatchObject({ code: 5, stdout: "" });
        expect(result.stderr).toContain("workspace_canvas_binding_ambiguous");
        expect(fixture.server.authorityScopes).toHaveLength(0);
        expect(fixture.server.catalogCount).toBe(0);
        expect(fixture.server.dispatchCount).toBe(0);
      } finally {
        await fixture.server.stop();
      }
    },
    cliWorkflowTimeoutMs
  );

  it.each([
    ["missing publish source", () => [{ canvasId: "remote-canvas-9", publishSource: null }]],
    [
      "wrong local Canvas",
      (localProjectId: string) => [
        {
          canvasId: "remote-canvas-9",
          publishSource: publishSource(localProjectId, "other-canvas")
        }
      ]
    ],
    [
      "wrong local project",
      () => [{ canvasId: "remote-canvas-9", publishSource: publishSource("other-local-project") }]
    ]
  ] as const)(
    "fails closed on a %s binding before authority, Catalog, or dispatch",
    async (_case, registryCanvases) => {
      const fixture = await remoteCanvasFixture({ registryCanvases });
      try {
        const result = await runCliExpectFailure(remoteRunArgv, fixture.env);
        expect(result).toMatchObject({ code: 5, stdout: "" });
        expect(result.stderr).toContain("workspace_canvas_binding_not_found");
        expect(fixture.server.authorityScopes).toHaveLength(0);
        expect(fixture.server.catalogCount).toBe(0);
        expect(fixture.server.dispatchCount).toBe(0);
      } finally {
        await fixture.server.stop();
      }
    },
    cliWorkflowTimeoutMs
  );

  it(
    "uses the resolved remote Canvas for agent endpoint discovery",
    async () => {
      const fixture = await remoteCanvasFixture({
        registryCanvases: (localProjectId) => [
          { canvasId: "remote-canvas-8", publishSource: publishSource(localProjectId) }
        ]
      });
      try {
        const result = JSON.parse((await runCli(endpointListArgv, fixture.env)).stdout);
        expect(result.items).toHaveLength(1);
        expect(fixture.server.catalogCanvasIds).toEqual(["remote-canvas-8"]);
        expect(fixture.server.dispatchCount).toBe(0);
      } finally {
        await fixture.server.stop();
      }
    },
    cliWorkflowTimeoutMs
  );

  it(
    "keeps agent endpoint discovery side-effect free when the binding is missing",
    async () => {
      const fixture = await remoteCanvasFixture({
        registryCanvases: () => [
          { canvasId: "remote-canvas-8", publishSource: publishSource("other-local-project") }
        ]
      });
      try {
        const result = await runCliExpectFailure(endpointListArgv, fixture.env);
        expect(result).toMatchObject({ code: 5, stdout: "" });
        expect(result.stderr).toContain("workspace_canvas_binding_not_found");
        expect(fixture.server.catalogCount).toBe(0);
        expect(fixture.server.dispatchCount).toBe(0);
      } finally {
        await fixture.server.stop();
      }
    },
    cliWorkflowTimeoutMs
  );
});
