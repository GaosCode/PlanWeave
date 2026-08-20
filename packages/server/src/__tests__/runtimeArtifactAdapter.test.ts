import { createHash } from "node:crypto";
import { appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  claimDispatchedBlock,
  createRemoteBlockArtifactSource,
  createRemoteBlockRuntimePort,
  submitBlockResult,
  type PlanPackageManifest
} from "@planweave-ai/runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  basicManifest,
  createTestWorkspace,
  writeReport
} from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { ArtifactStore } from "../artifacts.js";
import { startPlanweaveServer, type PlanweaveServer } from "../lifecycle.js";
import { RuntimeInputArtifactMaterializer } from "../runtimeArtifactAdapter.js";

const directories: string[] = [];
const servers: PlanweaveServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function dependencyManifest(): PlanPackageManifest {
  const manifest = basicManifest();
  manifest.execution.defaultExecutor = "codex-acp";
  manifest.executors = {
    "codex-acp": { adapter: "agent", agent: "codex", runner: { transport: "acp" } }
  };
  const task = manifest.nodes[0];
  if (task.type !== "task") throw new Error("Expected task fixture");
  task.blocks.splice(1, 0, {
    id: "B-002",
    type: "implementation",
    title: "Consume first implementation",
    prompt: "nodes/T-001/blocks/B-002.prompt.md",
    depends_on: ["B-001"]
  });
  const review = task.blocks.find((block) => block.id === "R-001");
  if (review) review.depends_on = ["B-002"];
  return manifest;
}

describe("RuntimeInputArtifactMaterializer", () => {
  it("imports only verified declared bytes, replays idempotently, and rejects drift or crossed refs", async () => {
    const workspace = await createTestWorkspace(dependencyManifest());
    directories.push(workspace.home, workspace.root);
    await claimDispatchedBlock({ projectRoot: workspace.root, ref: "T-001#B-001" });
    const report = Buffer.from("# Verified dependency\n");
    await submitBlockResult({
      projectRoot: workspace.root,
      ref: "T-001#B-001",
      reportPath: await writeReport(workspace.root, "dependency.md", report.toString("utf8"))
    });
    const runtime = createRemoteBlockRuntimePort({ projectRoot: workspace.root });
    const candidate = await runtime.inspect({ ref: "T-001#B-002" });
    const source = createRemoteBlockArtifactSource({ projectRoot: workspace.root });
    const dataDirectory = join(workspace.root, "server-data");
    const server = await startPlanweaveServer({
      dataDirectory,
      databasePath: join(dataDirectory, "server.sqlite"),
      busyTimeoutMs: 5_000
    });
    servers.push(server);
    const store = new ArtifactStore(server.database, dataDirectory, 1024 * 1024);
    const materializer = new RuntimeInputArtifactMaterializer(store);

    await materializer.materialize(candidate, source);
    await materializer.materialize(candidate, source);
    const declared = candidate.inputArtifacts[0];
    if (!declared) throw new Error("Expected declared input artifact");
    await expect(store.read(declared.artifactRef)).resolves.toEqual(report);

    const crossedDigest = createHash("sha256").update("foreign").digest("hex");
    await expect(
      materializer.materialize(
        {
          ...candidate,
          inputArtifacts: [
            {
              ...declared,
              artifactRef: `artifact:sha256:${crossedDigest}`
            }
          ]
        },
        source
      )
    ).rejects.toThrow("remote_block_artifact_not_declared");

    await appendFile(
      join(workspace.init.workspace.packageDir, "nodes/T-001/blocks/B-002.prompt.md"),
      "\nsource drift\n",
      "utf8"
    );
    await expect(materializer.materialize(candidate, source)).rejects.toThrow(
      "remote_block_artifact_source_revision_mismatch"
    );
  });
});
