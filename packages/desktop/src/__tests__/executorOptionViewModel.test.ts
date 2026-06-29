import { describe, expect, it } from "vitest";
import { buildExecutorOptionViews, executorOptionNames } from "../renderer/executors/executorOptionViewModel";

describe("executor option view model", () => {
  it("keeps manifest executors authoritative even when local detection does not install them", () => {
    const options = buildExecutorOptionViews({
      agentDetections: [
        {
          kind: "codex",
          name: "Codex",
          command: "codex",
          versionArgs: ["--version"],
          execArgs: ["exec", "-"],
          fullAccessArgs: ["--dangerously-bypass-approvals-and-sandbox", "exec", "-"],
          installed: false,
          version: null,
          unavailableReason: "not found"
        }
      ],
      currentExecutorNames: ["legacy-executor"],
      executorOptions: ["manual", "custom-shell", "codex", "custom-shell"]
    });

    expect(options).toEqual([
      {
        name: "legacy-executor",
        source: "current-value",
        detected: null,
        detectionMessage: null
      },
      {
        name: "manual",
        source: "manifest",
        detected: null,
        detectionMessage: null
      },
      {
        name: "custom-shell",
        source: "manifest",
        detected: null,
        detectionMessage: null
      },
      {
        name: "codex",
        source: "manifest",
        detected: false,
        detectionMessage: "not found"
      }
    ]);
  });

  it("does not duplicate the current executor when it already exists in graph options", () => {
    expect(
      executorOptionNames({
        currentExecutorNames: ["custom-shell"],
        executorOptions: ["manual", "custom-shell"]
      })
    ).toEqual(["manual", "custom-shell"]);
  });
});
