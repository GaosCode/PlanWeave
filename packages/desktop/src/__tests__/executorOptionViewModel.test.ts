import { describe, expect, it } from "vitest";
import {
  buildExecutorOptionViews,
  executorOptionNames
} from "../renderer/executors/executorOptionViewModel";

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
        disabled: false,
        label: "legacy-executor",
        name: "legacy-executor",
        source: "current-value",
        detected: null,
        detectionMessage: null
      },
      {
        disabled: false,
        label: "manual",
        name: "manual",
        source: "manifest",
        detected: null,
        detectionMessage: null
      },
      {
        disabled: false,
        label: "custom-shell",
        name: "custom-shell",
        source: "manifest",
        detected: null,
        detectionMessage: null
      },
      {
        disabled: true,
        label: "codex",
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

  it("folds builtin executor aliases into canonical agent names", () => {
    expect(
      executorOptionNames({
        currentExecutorNames: ["pi-auto"],
        executorOptions: [
          "default",
          "manual",
          "codex",
          "codex-auto",
          "claude-code-auto",
          "pi",
          "pi-auto"
        ]
      })
    ).toEqual(["manual", "codex", "claude-code", "pi"]);
  });
});
