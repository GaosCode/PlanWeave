import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCodexExecAdapter, runAutoRunStep } from "../index.js";
import { readJsonFile } from "../json.js";
import { createTestWorkspace } from "./promptTestHelpers.js";
import { manifestTestBuilder } from "./manifestTestBuilder.js";

describe("executor output limits", () => {
  it("blocks a codex-exec run when stdout exceeds the configured output limit", async () => {
    const manifest = manifestTestBuilder()
      .withExecutor("loud-codex", {
        adapter: "codex-exec",
        command: process.execPath,
        args: ["-e", "process.stdout.write('x'.repeat(2048)); setTimeout(() => {}, 1000);"],
        maxStdoutBytes: 128,
        maxStderrBytes: 128
      })
      .withDefaultExecutor("loud-codex")
      .build();
    const { root, init } = await createTestWorkspace(manifest);

    const step = await runAutoRunStep({
      projectRoot: root,
      executor: createCodexExecAdapter({
        projectRoot: root,
        executorName: "loud-codex",
        runtime: { tmuxEnabled: false }
      })
    });

    expect(step).toMatchObject({
      kind: "blocked",
      claim: {
        kind: "blocked",
        ref: "T-001#B-001",
        reason: expect.stringContaining("exceeded stdout output limit of 128 bytes")
      }
    });
    const runDir = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001");
    await expect(readJsonFile(join(runDir, "metadata.json"))).resolves.toMatchObject({
      executor: "loud-codex",
      adapter: "codex-exec",
      exitCode: 1,
      timeoutMs: 1800000,
      maxStdoutBytes: 128,
      maxStderrBytes: 128,
      timedOut: false
    });
    expect((await stat(join(runDir, "stdout.md"))).size).toBeLessThan(256);
    await expect(readFile(join(runDir, "stdout.md"), "utf8")).resolves.toContain(
      "stdout output truncated after 128 bytes"
    );
  });

  it("blocks a codex-exec run when stderr exceeds the configured output limit", async () => {
    const manifest = manifestTestBuilder()
      .withExecutor("noisy-codex", {
        adapter: "codex-exec",
        command: process.execPath,
        args: ["-e", "process.stderr.write('e'.repeat(2048)); setTimeout(() => {}, 1000);"],
        maxStdoutBytes: 128,
        maxStderrBytes: 96
      })
      .withDefaultExecutor("noisy-codex")
      .build();
    const { root, init } = await createTestWorkspace(manifest);

    const step = await runAutoRunStep({
      projectRoot: root,
      executor: createCodexExecAdapter({
        projectRoot: root,
        executorName: "noisy-codex",
        runtime: { tmuxEnabled: false }
      })
    });

    expect(step).toMatchObject({
      kind: "blocked",
      claim: {
        kind: "blocked",
        ref: "T-001#B-001",
        reason: expect.stringContaining("exceeded stderr output limit of 96 bytes")
      }
    });
    const runDir = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001");
    await expect(readJsonFile(join(runDir, "metadata.json"))).resolves.toMatchObject({
      executor: "noisy-codex",
      adapter: "codex-exec",
      exitCode: 1,
      timeoutMs: 1800000,
      maxStdoutBytes: 128,
      maxStderrBytes: 96,
      timedOut: false
    });
    expect((await stat(join(runDir, "stderr.log"))).size).toBeLessThan(224);
    await expect(readFile(join(runDir, "stderr.log"), "utf8")).resolves.toContain(
      "stderr output truncated after 96 bytes"
    );
  });
});
