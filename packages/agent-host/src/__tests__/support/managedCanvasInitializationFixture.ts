import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentHostConfig } from "../../config/schema.js";
import { ConfiguredCanvasRuntimeResolver } from "../../runtime/canvasRuntimeResolver.js";

export async function managedCanvasInitializationFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "planweave-managed-init-")));
  await mkdir(join(root, "workspaces"));
  const config = parseAgentHostConfig({
    version: "agent-host-config/v1",
    coordinator: { url: "https://coordinator.example.com" },
    dataDirectory: join(root, "data"),
    workspaceRoot: join(root, "workspaces"),
    host: { displayName: "Initialization Host", capacity: 1, capabilities: [] },
    workspaces: [],
    agentProfiles: []
  });
  const scope = { workspaceId: "workspace-a", projectId: "project-a", canvasId: "canvas-a" };
  const projectRoot = join(
    config.dataDirectory,
    "runtime-canvases",
    scope.workspaceId,
    scope.canvasId,
    "projects",
    scope.projectId
  );
  const canvasRoot = join(projectRoot, "canvases", scope.canvasId);
  const paths = [
    join(projectRoot, "project.json"),
    join(projectRoot, "project-graph.json"),
    join(canvasRoot, "state.json"),
    join(projectRoot, "policy", "project-prompt.md")
  ];
  return {
    root,
    config,
    scope,
    projectRoot,
    paths,
    resolver: new ConfiguredCanvasRuntimeResolver(config)
  };
}
