import { describe, expect, it } from "vitest";
import { createProgram } from "../index.js";
import { commandOptionLongs, nestedSubcommandOptionLongs, programOptionLongs, subcommandOptionLongs } from "./cliCommandTestHelpers.js";

describe("planweave CLI command registration", () => {
  it("registers agent workflow commands", () => {
    const commandNames = createProgram().commands.map((command) => command.name());

    expect(commandNames).toEqual(
      expect.arrayContaining([
        "paths",
        "resolve-divergence",
        "mark-blocked",
        "unblock",
        "retry-review",
        "edit-task",
        "edit-block",
        "claim",
        "claim-task",
        "claim-next",
        "explain",
        "why-not",
        "current",
        "doctor",
        "use",
        "submit-feedback",
        "reset",
        "run",
        "run-sessions",
        "run-session",
        "executors",
        "run-status",
        "canvas",
        "project-graph",
        "graph",
        "package-draft",
        "package",
        "import-recovery",
        "schema",
        "mcp",
        "server",
        "task",
        "merge-queue",
        "help"
      ])
    );
  });

  it("registers MCP tunnel commands", () => {
    const mcp = createProgram().commands.find((command) => command.name() === "mcp");
    expect(mcp?.commands.map((command) => command.name())).toEqual(expect.arrayContaining(["serve", "tunnel"]));
    const tunnel = mcp?.commands.find((command) => command.name() === "tunnel");
    expect(tunnel?.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(["download", "set-binary", "configure", "status", "doctor", "run", "print-systemd"])
    );
    expect(subcommandOptionLongs("mcp", "serve")).toEqual(expect.arrayContaining(["--host", "--port", "--token", "--oauth", "--json"]));
    expect(nestedSubcommandOptionLongs("mcp", "tunnel", "status")).toContain("--json");
    expect(nestedSubcommandOptionLongs("mcp", "tunnel", "doctor")).toContain("--json");
  });

  it("registers remote server subcommands", () => {
    const server = createProgram().commands.find((command) => command.name() === "server");
    expect(server?.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(["start", "join", "project", "list", "forget"])
    );
    expect(subcommandOptionLongs("server", "start")).toEqual(
      expect.arrayContaining(["--port", "--data-dir", "--allow-insecure-lan", "--join-token"])
    );
    expect(subcommandOptionLongs("server", "join")).toEqual(
      expect.arrayContaining(["--url", "--name", "--project", "--user", "--json"])
    );
    expect(subcommandOptionLongs("server", "project")).toEqual(
      expect.arrayContaining(["--profile", "--id", "--json"])
    );
    expect(subcommandOptionLongs("server", "list")).toContain("--json");
    expect(subcommandOptionLongs("server", "forget")).toEqual(
      expect.arrayContaining(["--name", "--json"])
    );
  });

  it("registers remote task subcommands", () => {
    const task = createProgram().commands.find((command) => command.name() === "task");
    expect(task?.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(["claim", "heartbeat", "checkout", "submit"])
    );
    expect(subcommandOptionLongs("task", "claim")).toEqual(
      expect.arrayContaining(["--profile", "--task-id", "--branch", "--base-commit", "--lease-seconds", "--json"])
    );
    expect(subcommandOptionLongs("task", "heartbeat")).toEqual(
      expect.arrayContaining(["--profile", "--lease-seconds", "--json"])
    );
    expect(subcommandOptionLongs("task", "checkout")).toEqual(
      expect.arrayContaining(["--profile", "--json"])
    );
    expect(subcommandOptionLongs("task", "submit")).toEqual(
      expect.arrayContaining(["--profile", "--head-commit", "--base-commit", "--json"])
    );
  });

  it("registers merge-queue with options", () => {
    expect(commandOptionLongs("merge-queue")).toEqual(
      expect.arrayContaining(["--profile", "--json"])
    );
  });

  it("registers global project root selection once", () => {
    expect(programOptionLongs()).toContain("--project-root");
  });

  it("supports machine-readable output options for agent-facing commands", () => {
    expect(commandOptionLongs("init")).toContain("--json");
    expect(commandOptionLongs("init")).toContain("--project-graph");
    expect(commandOptionLongs("init")).toContain("--reset-package");
    expect(commandOptionLongs("init")).toContain("--reset-results");
    expect(commandOptionLongs("validate")).toContain("--json");
    expect(commandOptionLongs("validate")).toContain("--canvas");
    expect(subcommandOptionLongs("canvas", "create")).toEqual(
      expect.arrayContaining(["--id", "--title", "--activate", "--dry-run", "--json"])
    );
    expect(commandOptionLongs("status")).toContain("--json");
    expect(commandOptionLongs("status")).toContain("--canvas");
    expect(commandOptionLongs("use")).toEqual(expect.arrayContaining(["--source-root", "--clear", "--json"]));
    expect(commandOptionLongs("claim")).toContain("--type");
    expect(commandOptionLongs("claim")).toContain("--dispatch");
    expect(commandOptionLongs("claim")).toContain("--canvas");
    expect(commandOptionLongs("claim-next")).toContain("--dry-run");
    expect(commandOptionLongs("claim-next")).toContain("--json");
    expect(commandOptionLongs("claim-next")).toContain("--canvas");
    expect(commandOptionLongs("current")).toContain("--json");
    expect(commandOptionLongs("submit-result")).toContain("--json");
    expect(commandOptionLongs("submit-review")).toContain("--json");
    expect(commandOptionLongs("submit-feedback")).toContain("--json");
    expect(commandOptionLongs("doctor")).toContain("--repair");
    expect(commandOptionLongs("doctor")).toContain("--canvas");
    expect(commandOptionLongs("doctor")).toContain("--project");
    expect(commandOptionLongs("retry-review")).toContain("--max-feedback-cycles");
    expect(commandOptionLongs("retry-review")).toContain("--canvas");
    expect(commandOptionLongs("edit-task")).toEqual(expect.arrayContaining(["--title", "--prompt-file", "--executor", "--clear-executor"]));
    expect(commandOptionLongs("edit-task")).toContain("--canvas");
    expect(commandOptionLongs("edit-block")).toEqual(
      expect.arrayContaining([
        "--title",
        "--prompt-file",
        "--parallel-safe",
        "--parallel-locks",
        "--review-required",
        "--max-feedback-cycles",
        "--review-hook-json",
        "--clear-review-hook"
      ])
    );
    expect(commandOptionLongs("edit-block")).toContain("--canvas");
    expect(commandOptionLongs("resolve-divergence")).toContain("--reason");
    expect(commandOptionLongs("resolve-divergence")).toContain("--canvas");
    expect(commandOptionLongs("unblock")).toContain("--reason");
    expect(commandOptionLongs("unblock")).toContain("--canvas");
    expect(commandOptionLongs("reset")).toEqual(expect.arrayContaining(["--canvas", "--force", "--reason", "--json"]));
    expect(commandOptionLongs("run")).toEqual(
      expect.arrayContaining(["--once", "--parallel", "--executor", "--scope", "--task", "--block", "--reset", "--force", "--reason", "--step-limit", "--json"])
    );
    expect(commandOptionLongs("run")).toContain("--canvas");
    expect(commandOptionLongs("run-sessions")).toEqual(expect.arrayContaining(["--canvas", "--json"]));
    expect(commandOptionLongs("run-session")).toEqual(expect.arrayContaining(["--canvas", "--json"]));
    expect(commandOptionLongs("run-status")).toContain("--json");
    expect(commandOptionLongs("run-status")).toContain("--canvas");
    expect(subcommandOptionLongs("graph", "inspect")).toEqual(
      expect.arrayContaining(["--view", "--task", "--limit", "--cursor", "--json", "--canvas"])
    );
    expect(subcommandOptionLongs("graph", "quality")).toEqual(
      expect.arrayContaining([
        "--json",
        "--canvas",
        "--review-policy",
        "--gate-policy",
        "--heuristics",
        "--strict",
        "--min-task-count-for-sparse-check"
      ])
    );
    expect(subcommandOptionLongs("package-draft", "validate")).toEqual(expect.arrayContaining(["--draft-root", "--json"]));
    expect(subcommandOptionLongs("package-draft", "quality")).toEqual(expect.arrayContaining(["--draft-root", "--json"]));
    expect(subcommandOptionLongs("package", "import")).toEqual(expect.arrayContaining(["--from", "--dry-run", "--apply", "--json", "--canvas"]));
    expect(subcommandOptionLongs("import-recovery", "list")).toContain("--json");
    expect(subcommandOptionLongs("import-recovery", "rollback")).toContain("--json");
    expect(subcommandOptionLongs("executors", "list")).toContain("--json");
    expect(subcommandOptionLongs("executors", "test")).toContain("--json");
    expect(commandOptionLongs("schema")).toContain("--json");
    expect(commandOptionLongs("help")).toContain("--json");
    for (const commandName of [
      "claim-task",
      "prompt",
      "explain",
      "why-not",
      "current",
      "submit-result",
      "submit-review",
      "submit-feedback",
      "mark-blocked",
      "mark-diverged",
      "refresh-prompt",
      "refresh-prompts"
    ]) {
      expect(commandOptionLongs(commandName), commandName).toContain("--canvas");
    }
  });

  it("rejects project doctor with canvas selection", async () => {
    const program = createProgram();
    program.exitOverride();
    program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });

    await expect(program.parseAsync(["doctor", "--project", "--canvas", "runtime"], { from: "user" })).rejects.toThrow(
      "doctor --project cannot be combined with --canvas."
    );
  });

  it("rejects invalid graph option values before calling runtime", async () => {
    const program = createProgram();
    program.exitOverride();
    program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });

    await expect(program.parseAsync(["graph", "inspect", "--view", "wide"], { from: "user" })).rejects.toThrow(
      "Invalid --view 'wide'. Expected one of: summary, tasks, slice."
    );
    await expect(program.parseAsync(["graph", "quality", "--heuristics", "maybe"], { from: "user" })).rejects.toThrow(
      "Invalid --heuristics 'maybe'. Expected one of: on, off."
    );
    await expect(program.parseAsync(["graph", "quality", "--min-task-count-for-sparse-check", "0"], { from: "user" })).rejects.toThrow(
      "Invalid --min-task-count-for-sparse-check '0'. Expected a positive integer."
    );
  });
});
