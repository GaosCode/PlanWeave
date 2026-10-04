import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { remoteInteractionViewSchema } from "@planweave-ai/collaboration-protocol/remote-run";
import { formatRemoteInteraction } from "../commands/remoteInteractionOutput.js";

const execFileAsync = promisify(execFile);
const context = {
  projectRoot: "/project root",
  canvasId: "canvas-1",
  sessionId: "session-1",
  connectionProfileId: "profile-1"
};
const identity = {
  actionId: "action-1",
  dispatchId: "dispatch-1",
  leaseId: "lease-1",
  executionAttemptId: "attempt-1",
  acpSessionId: "acp-session-1",
  expiresAt: "2030-01-01T01:00:00.000Z"
};
function view(request: object) {
  return remoteInteractionViewSchema.parse({
    request: { ...identity, ...request },
    operationId: "operation-1",
    hostId: "host-1",
    status: "pending",
    createdAt: "2030-01-01T00:00:00.000Z"
  });
}
function permission(optionId: string, title = "Run a tool", description = "Choose carefully") {
  return view({
    type: "interaction.permission_requested",
    title,
    description,
    options: [{ optionId, label: "Allow once", kind: "allow_once" }]
  });
}
function command(output: string, shell: "POSIX" | "PowerShell") {
  const start = output.indexOf(`${shell}: `);
  const end = output.indexOf(`\n${shell === "POSIX" ? "PowerShell:" : "Cancel:"}`, start);
  if (start < 0 || end < 0) throw new Error(`Missing ${shell} response template`);
  return output.slice(start + shell.length + 2, end);
}
const expectedBase = [
  "--project-root",
  "/project root",
  "interaction",
  "respond",
  "--canvas",
  "canvas-1",
  "--session",
  "session-1",
  "--connection-profile",
  "profile-1",
  "--action",
  "action-1",
  "--dispatch",
  "dispatch-1",
  "--lease",
  "lease-1",
  "--attempt",
  "attempt-1",
  "--acp-session",
  "acp-session-1"
];

describe("remote interaction human output", () => {
  it("shows permission context and exact option IDs without inventing allow_once", () => {
    const output = formatRemoteInteraction(permission("server-specific-choice"), context);
    for (const text of [
      "Title: Run a tool",
      "Description: Choose carefully",
      "Option ID: server-specific-choice",
      "Label: Allow once",
      "Kind: allow_once",
      "Canvas: canvas-1",
      "Session: session-1",
      "ACP session: acp-session-1",
      "Cancel:"
    ])
      expect(output).toContain(text);
    expect(output).not.toContain("'--option=allow_once'");
  });

  it("shows elicitation prompts and choices and handles empty choices without invention", () => {
    const request = { type: "interaction.elicitation_requested", prompt: "Which branch?" };
    const output = formatRemoteInteraction(
      view({ ...request, options: ["main", "release"] }),
      context
    );
    expect(output).toContain("Prompt: Which branch?");
    expect(output).toContain("Option: release");
    const empty = formatRemoteInteraction(view({ ...request, options: [] }), context);
    expect(empty).toContain("No options advertised");
    expect(empty).toContain("Cancel:");
    expect(empty).not.toContain("Response:");
  });

  it("explains Host authentication and retry marker semantics", () => {
    const output = formatRemoteInteraction(
      view({
        type: "interaction.authentication_required",
        agentProfileId: "codex-acp",
        hostInstruction: "Sign in on the Host"
      }),
      context
    );
    expect(output).toContain("Host instruction: Sign in on the Host");
    expect(output).toContain("not a permission option");
    expect(output).toContain("'--option=retry_after_host_login'");
  });

  it("quotes PowerShell literals with doubled apostrophes and keeps interpolation characters literal", () => {
    const output = formatRemoteInteraction(
      permission("space 'quote' \"double\" $dollar `tick;\nline"),
      context
    );
    expect(command(output, "PowerShell")).toContain(
      "'--option=space ''quote'' \"double\" $dollar `tick;\nline'"
    );
  });

  it.each([
    ["\u2018", "\u2018\u2018"],
    ["\u2019", "\u2019\u2019"],
    ["\u201a", "\u201a\u201a"],
    ["\u201b", "\u201b\u201b"],
    ["'\u2018\u2019\u201a\u201b", "''\u2018\u2018\u2019\u2019\u201a\u201a\u201b\u201b"]
  ])("escapes every PowerShell single quote in %j without changing exact option IDs", (quote, escaped) => {
    const option = `safe${quote}; Write-Output REVIEW_SENTINEL; #`;
    const request = permission(option);
    const before = JSON.stringify(request);
    const output = formatRemoteInteraction(request, context);
    expect(command(output, "PowerShell")).toContain(
      `'--option=safe${escaped}; Write-Output REVIEW_SENTINEL; #'`
    );
    expect(JSON.stringify(request)).toBe(before);
  });

  const bidiControls = [
    "\u061c",
    "\u200e",
    "\u200f",
    "\u202a",
    "\u202b",
    "\u202c",
    "\u202d",
    "\u202e",
    "\u2066",
    "\u2067",
    "\u2068",
    "\u2069"
  ];
  it.each(
    bidiControls
  )("filters bidi control %j from display text without changing DTO JSON", (control) => {
    const request = permission("exact-id", `Approve ${control}denied`, `First${control}\nSecond`);
    const before = JSON.stringify(request);
    const output = formatRemoteInteraction(request, context);
    expect(output).not.toContain(control);
    expect(output).toContain("Title: Approve denied");
    expect(output).toContain("Description: First\n  Second");
    expect(output).toContain("POSIX:");
    expect(JSON.stringify(request)).toBe(before);
  });
  it.each(bidiControls)("refuses exact option and scope containing bidi control %j", (control) => {
    const request = permission(`choice${control}tail`);
    const before = JSON.stringify(request);
    const output = formatRemoteInteraction(request, context);
    expect(output).not.toContain(control);
    expect(output).toContain("Response: command unavailable");
    expect(output).not.toContain("'--option=");
    expect(JSON.stringify(request)).toBe(before);
    const scope = { ...context, projectRoot: `/root${control}tail` };
    const scopeBefore = JSON.stringify(scope);
    const unsafeScope = formatRemoteInteraction(permission("exact-id"), scope);
    expect(unsafeScope).not.toContain(control);
    expect(unsafeScope).toContain("Cancel: command unavailable");
    expect(unsafeScope).not.toContain("POSIX:");
    expect(JSON.stringify(scope)).toBe(scopeBefore);
  });

  it("refuses all response templates for unsafe command scope without changing the DTO", () => {
    const request = permission("exact-id");
    const output = formatRemoteInteraction(request, { ...context, projectRoot: "/root\x1b[2J" });
    expect(output).toContain("Response: command unavailable");
    expect(output).toContain("Cancel: command unavailable");
    expect(output).not.toContain("POSIX:");
    expect(request.request.actionId).toBe("action-1");
  });

  it("directs legacy permission to Host execution cancellation without an unusable template", () => {
    const output = formatRemoteInteraction(
      view({
        type: "interaction.permission_requested",
        title: "Legacy request",
        description: "Old Host"
      }),
      context
    );
    expect(output).toContain("cancel execution on the Host");
    expect(output).not.toContain("POSIX:");
  });

  it("removes ANSI/OSC and terminal controls while preserving readable newlines", () => {
    const output = formatRemoteInteraction(
      permission(
        "exact-id",
        "\x1b[31mRed\x1b[0m\x1b]0;spoofed-title\x07",
        "First\nSecond\rOverwrite\x9b31mHidden"
      ),
      context
    );
    expect(output).toContain("Title: Red");
    expect(output).toContain("Description: First\n  SecondOverwriteHidden");
    expect(output).not.toContain("spoofed-title");
    for (const control of ["\x1b", "\x07", "\r", "\x9b"]) expect(output).not.toContain(control);
  });

  it.each([
    "\x00",
    "\x1b",
    "\r",
    "\x9b"
  ])("refuses unsafe exact option argv containing %j instead of sanitizing its identity", (control) => {
    const output = formatRemoteInteraction(permission(`choice${control}tail`), context);
    expect(output).toContain("Response: command unavailable");
    expect(output).not.toContain("'--option=");
    expect(output).toContain("Cancel:");
  });

  const specialOptions = [
    "space value",
    "single'quote",
    'double"quote',
    "$dollar",
    "`backtick",
    ";semicolon",
    "line\nbreak",
    "$(touch SHOULD_NOT_EXECUTE)",
    "--leading-dashes",
    "safe\u2018; Write-Output REVIEW_SENTINEL; #",
    "safe\u2019; Write-Output REVIEW_SENTINEL; #",
    "safe\u201a; Write-Output REVIEW_SENTINEL; #",
    "safe\u201b; Write-Output REVIEW_SENTINEL; #",
    "mixed'\u2018\u2019\u201a\u201b; Write-Output REVIEW_SENTINEL; #"
  ];
  it.each(
    specialOptions
  )("POSIX template round trips exact argv %j through an inert receiver", async (option) => {
    const output = formatRemoteInteraction(permission(option), context);
    const script = `planweave() { node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' -- "$@"; };\n${command(output, "POSIX")}`;
    const received = await execFileAsync("sh", ["-c", script]);
    expect(JSON.parse(received.stdout)).toEqual([...expectedBase, `--option=${option}`]);
  });

  const hasPowerShell = spawnSync("pwsh", [
    "-NoProfile",
    "-Command",
    "$PSVersionTable.PSVersion.ToString()"
  ]);
  it.skipIf(hasPowerShell.error?.message.includes("ENOENT") === true).each(specialOptions)(
    "PowerShell template round trips exact argv %j without additional sentinel output",
    async (option) => {
      const output = formatRemoteInteraction(permission(option), context);
      const script = `function planweave { ConvertTo-Json -Compress -InputObject @($args) };\n${command(output, "PowerShell")}`;
      const received = await execFileAsync("pwsh", ["-NoProfile", "-Command", script]);
      expect(JSON.parse(received.stdout)).toEqual([...expectedBase, `--option=${option}`]);
    }
  );
});
