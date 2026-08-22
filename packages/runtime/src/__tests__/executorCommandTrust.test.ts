import { afterEach, describe, expect, it } from "vitest";
import {
  createExecutorAdapter,
  getExecutionStatus,
  isCommandTrusted,
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
      executorName: "custom-node",
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
    expect(await isCommandTrusted(root, process.execPath, args)).toBe(true);
    await unblockBlock({
      projectRoot: root,
      ref: "T-001#B-001",
      reason: "trusted custom executor"
    });
    const allowed = await runAutoRunStep({
      projectRoot: root,
      executorName: "custom-node",
      tmuxEnabled: false
    });
    expect(allowed).toMatchObject({
      kind: "submitted",
      claim: { kind: "block", ref: "T-001#B-001" },
      submitResult: { ref: "T-001#B-001", status: "completed" }
    });
  });

  it.each([
    {
      name: "command path",
      command: `${process.execPath}-changed`,
      args: fakeCodexArgs()
    },
    {
      name: "arguments",
      command: process.execPath,
      args: [...fakeCodexArgs(), "--changed"]
    }
  ])("keeps the executor blocked when its $name changes", async ({ command, args }) => {
    const trustedArgs = fakeCodexArgs();
    const manifest = manifestTestBuilder()
      .withExecutor("custom-node", {
        adapter: "codex-exec",
        command,
        args
      })
      .withDefaultExecutor("custom-node")
      .build();
    const { root } = await createTestWorkspace(manifest, { trustPackageExecutors: false });

    await trustCommand(root, process.execPath, trustedArgs);
    expect(await isCommandTrusted(root, command, args)).toBe(false);

    const result = await runAutoRunStep({
      projectRoot: root,
      executorName: "custom-node",
      tmuxEnabled: false
    });
    expect(result).toMatchObject({
      kind: "blocked",
      claim: {
        kind: "blocked",
        ref: "T-001#B-001",
        reason: expect.stringContaining("Executor command is not trusted on this machine")
      }
    });
  });

  it("keeps executor trust scoped to one project", async () => {
    const args = fakeCodexArgs();
    const manifest = manifestTestBuilder()
      .withExecutor("custom-node", {
        adapter: "codex-exec",
        command: process.execPath,
        args
      })
      .withDefaultExecutor("custom-node")
      .build();
    const trustedProject = await createTestWorkspace(manifest, {
      trustPackageExecutors: false
    });
    await trustCommand(trustedProject.root, process.execPath, args);
    const otherProject = await createTestWorkspace(manifest, {
      trustPackageExecutors: false,
      planweaveHome: trustedProject.home
    });

    expect(await isCommandTrusted(otherProject.root, process.execPath, args)).toBe(false);
    const result = await runAutoRunStep({
      projectRoot: otherProject.root,
      executorName: "custom-node",
      tmuxEnabled: false
    });
    expect(result).toMatchObject({
      kind: "blocked",
      claim: {
        kind: "blocked",
        ref: "T-001#B-001",
        reason: expect.stringContaining("Executor command is not trusted on this machine")
      }
    });
  });

  it("leaves builtin adapter profiles ungated", async () => {
    const { root } = await createTestWorkspace();
    const profiles = await listExecutorProfiles({ projectRoot: root });
    expect(profiles.find((profile) => profile.name === "codex")).toMatchObject({
      source: "builtin",
      runnerKind: "acp",
      acpLaunch: {
        command: "codex-acp"
      }
    });
    expect(createExecutorAdapter({ projectRoot: root, executorName: "codex" })).toBeDefined();
  });
});
