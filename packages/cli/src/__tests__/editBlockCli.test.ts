import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addTaskNode } from "@planweave-ai/runtime";
import { runCli } from "./support/cliTestHarness.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
});

describe("edit-block CLI", () => {
  it("persists canonical shared resource hints through the runtime command", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-edit-block-home-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "planweave-edit-block-project-"));
    const env = { ...process.env, PLANWEAVE_HOME: home };
    process.env.PLANWEAVE_HOME = home;
    const init = JSON.parse(
      (await runCli(["--project-root", projectRoot, "init", "--json"], env)).stdout
    ) as { workspace: { packageDir: string; workspaceRoot: string } };
    await addTaskNode(init.workspace.workspaceRoot, {
      title: "CLI shared resources",
      promptMarkdown: "# CLI shared resources\n"
    });
    const initialManifest = JSON.parse(
      await readFile(join(init.workspace.packageDir, "manifest.json"), "utf8")
    ) as { nodes: Array<{ id: string; title: string }> };
    const taskId = initialManifest.nodes.find((task) => task.title === "CLI shared resources")?.id;
    if (!taskId) {
      throw new Error("Expected runtime to create the CLI shared resources task.");
    }

    await runCli(
      [
        "--project-root",
        projectRoot,
        "edit-block",
        `${taskId}#B-001`,
        "--shared-resources",
        "api, repository,api"
      ],
      env
    );

    const manifest = JSON.parse(
      await readFile(join(init.workspace.packageDir, "manifest.json"), "utf8")
    ) as {
      nodes: Array<{
        id: string;
        blocks: Array<{
          id: string;
          parallel?: Record<string, unknown> & { sharedResources?: string[] };
        }>;
      }>;
    };
    const block = manifest.nodes
      .find((task) => task.id === taskId)
      ?.blocks.find((item) => item.id === "B-001");

    expect(block?.parallel).toEqual({ sharedResources: ["api", "repository"] });
    expect(block?.parallel).not.toHaveProperty("safe");
    expect(block?.parallel).not.toHaveProperty("locks");
  });
});
