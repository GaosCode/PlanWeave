import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { createCliRunner } from "../autoRun/cliRunner.js";
import type { CliProcessExecutor, CliProcessRequest } from "../autoRun/cliProcess.js";
import { grokAgentDefinition } from "../autoRun/grokIntegration.js";
import { createGrokExecAdapter, getAutoRunStatus } from "../index.js";
import { executorProfileSchema } from "../types.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

function successfulProcess(
  onRequest: (request: CliProcessRequest) => void | Promise<void>
): CliProcessExecutor {
  return async (request) => {
    await onRequest(request);
    return {
      stdout: "Grok completed the requested implementation.",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      tmux: null
    };
  };
}

describe("Grok CLI integration", () => {
  it("publishes canonical CLI and ACP profiles for the Grok agent", () => {
    expect(createGrokExecAdapter).toBeTypeOf("function");
    expect(grokAgentDefinition.builtinProfiles).toMatchObject({
      grok: {
        adapter: "agent",
        agent: "grok",
        runner: { transport: "cli" },
        command: "grok",
        args: ["--no-auto-update", "--prompt-file"]
      },
      "grok-acp": {
        adapter: "agent",
        agent: "grok",
        runner: { transport: "acp" }
      }
    });
    expect(grokAgentDefinition.cli?.integration).toBe("grok-exec");
  });

  it("normalizes the legacy Grok CLI adapter to the canonical runner contract", () => {
    expect(
      executorProfileSchema.parse({
        adapter: "grok-exec",
        command: "grok"
      })
    ).toEqual({
      adapter: "agent",
      agent: "grok",
      runner: { transport: "cli" },
      command: "grok",
      args: ["--no-auto-update", "--prompt-file"]
    });
  });

  it.each([
    [["--prompt-file"], "must include '--no-auto-update'"],
    [
      ["--no-auto-update", "--prompt-file", "plain"],
      "must contain exactly one '--prompt-file' as the final argument"
    ],
    [
      ["--no-auto-update", "--prompt-file", "--prompt-file"],
      "must contain exactly one '--prompt-file' as the final argument"
    ]
  ])("rejects Grok CLI args that violate the prompt-file contract", (args, message) => {
    expect(() =>
      executorProfileSchema.parse({
        adapter: "agent",
        agent: "grok",
        runner: { transport: "cli" },
        command: "grok",
        args
      })
    ).toThrow(message);
  });

  it("passes the canonical prompt by file without copying it into argv or stdin", async () => {
    const { init } = await createTestWorkspace();
    let observedRequest: CliProcessRequest | null = null;
    const runner = createCliRunner({
      executeProcess: successfulProcess((request) => {
        observedRequest = request;
      })
    });
    const profile = grokAgentDefinition.builtinProfiles.grok;
    if (!profile || profile.runner.transport !== "cli" || !("command" in profile)) {
      throw new Error("Grok CLI profile is unavailable.");
    }
    const prompt = "Implement the focused Grok CLI task.";

    const result = await runner.runBlock(
      {
        projectRoot: init.workspace,
        claim: {
          kind: "block",
          ref: "T-001#B-001",
          taskId: "T-001",
          blockId: "B-001",
          blockType: "implementation",
          effectiveExecutor: "grok"
        },
        prompt,
        executorName: "grok",
        profile
      },
      grokAgentDefinition
    );

    expect(result).toMatchObject({
      kind: "block",
      adapter: "grok-exec",
      agentId: "grok",
      runnerKind: "cli"
    });
    expect(observedRequest).not.toBeNull();
    const request = observedRequest!;
    expect(request.command).toBe("grok");
    expect(request.args.slice(0, -1)).toEqual(["--no-auto-update", "--prompt-file"]);
    expect(request.args).not.toContain(prompt);
    expect(request.stdin).toBe("");
    const promptPath = request.args.at(-1);
    expect(promptPath).toBeDefined();
    await expect(readFile(promptPath!, "utf8")).resolves.toBe(prompt);
    expect(dirname(promptPath!)).toContain("RUN-001");
    await expect(getAutoRunStatus({ projectRoot: init.workspace })).resolves.toMatchObject({
      latestRuns: [
        expect.objectContaining({
          adapter: "grok-exec",
          agentId: "grok",
          runnerKind: "cli"
        })
      ]
    });
  });

  it("rewrites the durable review prompt before Grok reads it by file", async () => {
    const { init } = await createTestWorkspace();
    let observedRequest: CliProcessRequest | null = null;
    const runner = createCliRunner({
      executeProcess: successfulProcess(async (request) => {
        observedRequest = request;
        const resultPath = request.env.PLANWEAVE_REVIEW_RESULT_PATH;
        const reviewBlockRef = request.env.PLANWEAVE_REVIEW_BLOCK_REF;
        const taskId = request.env.PLANWEAVE_TASK_ID;
        if (!resultPath || !reviewBlockRef || !taskId) {
          throw new Error("Grok review result environment is unavailable.");
        }
        await writeFile(
          resultPath,
          JSON.stringify({
            reviewBlockRef,
            taskId,
            verdict: "passed",
            content: "Grok review passed."
          }),
          "utf8"
        );
      })
    });
    const profile = grokAgentDefinition.builtinProfiles.grok;
    if (!profile || profile.runner.transport !== "cli" || !("command" in profile)) {
      throw new Error("Grok CLI profile is unavailable.");
    }

    const result = await runner.runBlock(
      {
        projectRoot: init.workspace,
        claim: {
          kind: "block",
          ref: "T-001#R-001",
          taskId: "T-001",
          blockId: "R-001",
          blockType: "review",
          effectiveExecutor: "grok"
        },
        prompt: "Review the focused implementation.",
        executorName: "grok",
        profile
      },
      grokAgentDefinition
    );

    expect(result).toMatchObject({
      kind: "review",
      adapter: "grok-exec",
      resultPath: expect.stringContaining("review-result.json")
    });
    expect(observedRequest).not.toBeNull();
    const promptPath = observedRequest!.args.at(-1);
    expect(promptPath).toBeDefined();
    await expect(readFile(promptPath!, "utf8")).resolves.toContain("Auto Run Review Result File");
  });

  it("passes feedback through the same durable Grok prompt-file contract", async () => {
    const { init } = await createTestWorkspace();
    let observedRequest: CliProcessRequest | null = null;
    const runner = createCliRunner({
      executeProcess: successfulProcess((request) => {
        observedRequest = request;
      })
    });
    const profile = grokAgentDefinition.builtinProfiles.grok;
    if (!profile || profile.runner.transport !== "cli" || !("command" in profile)) {
      throw new Error("Grok CLI profile is unavailable.");
    }
    const content = "Address the focused review feedback.";

    const result = await runner.runFeedback(
      {
        projectRoot: init.workspace,
        workspace: init.workspace,
        claim: {
          kind: "feedback",
          feedbackId: "FE-001",
          sourceReviewBlockRef: "T-001#R-001",
          taskId: "T-001",
          content,
          effectiveExecutor: "grok"
        },
        executorName: "grok",
        profile
      },
      grokAgentDefinition
    );

    expect(result).toMatchObject({ kind: "feedback", adapter: "grok-exec" });
    expect(observedRequest).not.toBeNull();
    const promptPath = observedRequest!.args.at(-1);
    expect(promptPath).toBeDefined();
    await expect(readFile(promptPath!, "utf8")).resolves.toBe(content);
  });
});
