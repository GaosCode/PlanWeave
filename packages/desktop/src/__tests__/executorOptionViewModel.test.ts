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
          runnerKind: "cli",
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
      executorOptions: ["manual", "custom-shell", "codex", "custom-shell"],
      literalExecutorNames: ["custom-shell"]
    });

    expect(options).toEqual([
      {
        disabled: false,
        label: "legacy-executor",
        name: "legacy-executor",
        source: "current-value",
        detected: null,
        detectionMessage: null,
        custom: false
      },
      {
        disabled: false,
        label: "manual",
        name: "manual",
        source: "manifest",
        detected: null,
        detectionMessage: null,
        custom: false
      },
      {
        disabled: false,
        label: "custom-shell",
        name: "custom-shell",
        source: "manifest",
        detected: null,
        detectionMessage: null,
        custom: true
      },
      {
        disabled: true,
        label: "codex",
        name: "codex",
        source: "manifest",
        detected: false,
        detectionMessage: "not found",
        custom: false
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
          "codex-acp",
          "claude-code-auto",
          "claude-code-acp",
          "opencode-acp",
          "pi",
          "pi-auto",
          "pi-acp",
          "grok-acp"
        ]
      })
    ).toEqual(["manual", "codex", "claude-code", "opencode", "pi", "grok"]);
  });

  it("uses only the selected transport when reporting agent availability", () => {
    const detections = [
      {
        kind: "codex" as const,
        runnerKind: "cli" as const,
        name: "Codex",
        command: "codex",
        versionArgs: ["--version"],
        execArgs: ["exec", "-"],
        fullAccessArgs: [],
        installed: true,
        version: "codex 1.0.0",
        unavailableReason: null
      },
      {
        kind: "codex" as const,
        runnerKind: "acp" as const,
        name: "Codex",
        command: "codex-acp",
        versionArgs: ["--version"],
        execArgs: [],
        fullAccessArgs: [],
        installed: false,
        version: null,
        unavailableReason: "not found"
      }
    ];

    expect(
      buildExecutorOptionViews({
        agentDetections: detections,
        agentTransport: "acp",
        executorOptions: ["codex"]
      })[0]
    ).toMatchObject({ disabled: true, detected: false, detectionMessage: "not found" });
  });

  it("uses the selected transport for the canonical Grok option", () => {
    const options = buildExecutorOptionViews({
      agentDetections: [
        {
          kind: "codex",
          runnerKind: "cli",
          name: "Codex",
          command: "codex",
          versionArgs: ["--version"],
          execArgs: ["exec", "-"],
          fullAccessArgs: [],
          installed: true,
          version: "codex 1.0.0",
          unavailableReason: null
        },
        {
          kind: "grok",
          runnerKind: "cli",
          name: "Grok",
          command: "grok",
          versionArgs: ["--version"],
          execArgs: ["--no-auto-update", "--prompt-file"],
          fullAccessArgs: ["--always-approve", "--no-auto-update", "--prompt-file"],
          installed: true,
          version: "grok 0.2.101",
          unavailableReason: null
        },
        {
          kind: "grok",
          runnerKind: "acp",
          name: "Grok",
          command: "grok",
          versionArgs: ["--no-auto-update", "agent", "stdio", "--help"],
          execArgs: ["--no-auto-update", "agent", "stdio"],
          fullAccessArgs: [],
          installed: false,
          version: null,
          unavailableReason: "grok ACP unavailable"
        }
      ],
      agentTransport: "cli",
      executorOptions: ["codex", "grok-acp"]
    });

    expect(options).toEqual([
      expect.objectContaining({ name: "codex", detected: true, disabled: false }),
      expect.objectContaining({
        name: "grok",
        detected: true,
        disabled: false,
        detectionMessage: "grok 0.2.101"
      })
    ]);
  });

  it("uses Grok ACP detection when ACP is the selected transport", () => {
    expect(
      buildExecutorOptionViews({
        agentDetections: [
          {
            kind: "grok",
            runnerKind: "acp",
            name: "Grok",
            command: "grok",
            versionArgs: ["--no-auto-update", "agent", "stdio", "--help"],
            execArgs: ["--no-auto-update", "agent", "stdio"],
            fullAccessArgs: [],
            installed: true,
            version: null,
            unavailableReason: null
          }
        ],
        agentTransport: "acp",
        executorOptions: ["grok-acp"]
      })[0]
    ).toMatchObject({ name: "grok", detected: true, disabled: false });
  });

  it("folds reserved aliases even when a package declares the same name", () => {
    expect(
      buildExecutorOptionViews({
        agentDetections: [],
        executorOptions: ["manual", "codex-acp"],
        literalExecutorNames: ["codex-acp"]
      })
    ).toEqual([
      expect.objectContaining({ name: "manual", custom: false }),
      expect.objectContaining({ name: "codex", custom: false })
    ]);
  });
});
