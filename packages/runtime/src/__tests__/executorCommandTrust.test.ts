import { afterEach, describe, expect, it } from "vitest";
import {
  createExecutorAdapter,
  getExecutionStatus,
  listExecutorProfiles,
  runAutoRunStep,
  trustCommand,
  unblockBlock
} from "../index.js";
import { createTestWorkspace } from "./promptTestHelpers.js";
import { manifestTestBuilder } from "./manifestTestBuilder.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
});

function fakeCodexArgs(): string[] {
  return [
    "-e",
    [
      "let input='';",
      "process.stdin.on('data', c => input += c);",
      "process.stdin.on('end', () => {",
      "  console.log('report:' + input.includes('Implement task'));",
      "});"
    ].join("")
  ];
}

describe("executor command trust gate", () => {
  it("refuses a package-authored executor command until it is trusted", async () => {
    const args = fakeCodexArgs();
    const manifest = manifestTestBuilder()
      .withExecutor("custom-node", {
        adapter: "codex-exec",
        command: process.execPath,
        args
      })
      .withDefaultExecutor("custom-node")
      .build();
    const { root } = await createTestWorkspace(manifest, { trustPackageExecutors: false });

    const refused = await runAutoRunStep({
      projectRoot: root,
      executor: createExecutorAdapter({ projectRoot: root, executorName: "custom-node" }),
      tmuxEnabled: false
    });

    expect(refused).toMatchObject({
      kind: "blocked",
      claim: {
        kind: "blocked",
        ref: "T-001#B-001",
        reason: expect.stringContaining(
          `Executor command is not trusted on this machine: "${process.execPath}". Approve it with: planweave trust executor custom-node`
        )
      }
    });

    const status = await getExecutionStatus({ projectRoot: root });
    expect(status.blocks.find((block) => block.ref === "T-001#B-001")).toMatchObject({
      status: "blocked",
      reason: expect.stringContaining("Executor command is not trusted on this machine")
    });

    await trustCommand(root, process.execPath, args);
    await unblockBlock({
      projectRoot: root,
      ref: "T-001#B-001",
      reason: "trusted custom executor"
    });
    const allowed = await runAutoRunStep({
      projectRoot: root,
      executor: createExecutorAdapter({ projectRoot: root, executorName: "custom-node" }),
      tmuxEnabled: false
    });
    expect(allowed).toMatchObject({
      kind: "submitted",
      claim: { kind: "block", ref: "T-001#B-001" },
      submitResult: { ref: "T-001#B-001", status: "completed" }
    });
  });

  it("leaves builtin adapter profiles ungated", async () => {
    const { root } = await createTestWorkspace();
    const profiles = await listExecutorProfiles({ projectRoot: root });
    expect(profiles.find((profile) => profile.name === "codex")).toMatchObject({
      source: "builtin",
      command: "codex"
    });
    expect(createExecutorAdapter({ projectRoot: root, executorName: "codex" })).toBeDefined();
  });
});
