import { describe, expect, it } from "vitest";
import { createProgram } from "../index.js";

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
    expect(commandOptionLongs("resolve-divergence")).toContain("--reason");
    expect(commandOptionLongs("unblock")).toContain("--reason");
    expect(commandOptionLongs("run")).toEqual(expect.arrayContaining(["--once", "--parallel", "--executor", "--json"]));
    expect(commandOptionLongs("run-status")).toContain("--json");
  });
});
