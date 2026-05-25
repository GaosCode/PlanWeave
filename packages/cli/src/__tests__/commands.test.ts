import { describe, expect, it } from "vitest";
import { createProgram } from "../index.js";
import { formatClaimHint } from "../commands/status.js";

function commandOptionLongs(name: string): string[] {
  const command = createProgram().commands.find((item) => item.name() === name);
  if (!command) {
    throw new Error(`Missing command '${name}'.`);
  }
  return command.options.flatMap((option) => (option.long ? [option.long] : []));
}

describe("planweave CLI contract", () => {
  it("registers agent workflow commands", () => {
    const commandNames = createProgram().commands.map((command) => command.name());

    expect(commandNames).toEqual(
      expect.arrayContaining([
        "paths",
        "resolve-divergence",
        "mark-blocked",
        "unblock",
        "claim",
        "claim-task",
        "claim-next",
        "explain",
        "why-not",
        "current",
        "doctor",
        "submit-feedback",
        "run",
        "executors",
        "run-status"
      ])
    );
  });

  it("supports json output for init, validate, and status", () => {
    expect(commandOptionLongs("init")).toContain("--json");
    expect(commandOptionLongs("init")).toContain("--reset-package");
    expect(commandOptionLongs("init")).toContain("--reset-results");
    expect(commandOptionLongs("validate")).toContain("--json");
    expect(commandOptionLongs("status")).toContain("--json");
    expect(commandOptionLongs("claim")).toContain("--type");
    expect(commandOptionLongs("claim-next")).toContain("--dry-run");
    expect(commandOptionLongs("doctor")).toContain("--repair");
    expect(commandOptionLongs("resolve-divergence")).toContain("--reason");
    expect(commandOptionLongs("unblock")).toContain("--reason");
    expect(commandOptionLongs("run")).toEqual(expect.arrayContaining(["--once", "--parallel", "--executor", "--json"]));
    expect(commandOptionLongs("run-status")).toContain("--json");
  });

  it("prints claim hint status reasons", () => {
    expect(
      formatClaimHint({
        ref: "T-001#B-001",
        taskId: "T-001",
        blockId: "B-001",
        blockType: "implementation",
        status: "blocked",
        statusReason: "Waiting for external API access.",
        ready: false,
        readyReason: null,
        blockedByBlocks: [],
        blockedByTasks: [],
        parallelSafe: true,
        sequentialOnly: false,
        recommendedCommand: null,
        reviewGate: null
      })
    ).toContain("blocked: Waiting for external API access.");
  });

  it("prints optional review claimability reasons before raw ready status", () => {
    expect(
      formatClaimHint({
        ref: "T-001#R-001",
        taskId: "T-001",
        blockId: "R-001",
        blockType: "review",
        status: "ready",
        statusReason: "Optional review gate is not required and is not claimable; task can complete without it.",
        ready: false,
        readyReason: null,
        blockedByBlocks: [],
        blockedByTasks: [],
        parallelSafe: false,
        sequentialOnly: true,
        recommendedCommand: null,
        reviewGate: {
          isGate: true,
          required: false,
          requiredReason: "Optional review gate; not required for task completion.",
          executorRole: "reviewer",
          downstreamTasks: [],
          unlocksTasks: [],
          needsChangesReturnsTo: ["T-001#B-001", "T-001#C-001"]
        }
      })
    ).toContain("ready: Optional review gate is not required and is not claimable; task can complete without it.");
  });
});
