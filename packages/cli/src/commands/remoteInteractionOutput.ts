import { stripVTControlCharacters } from "node:util";
import type { RemoteInteractionView } from "@planweave-ai/collaboration-protocol/remote-run";

type CommandContext = {
  projectRoot: string;
  canvasId: string;
  sessionId: string;
  connectionProfileId: string;
};

function unsafeTerminalControl(character: string): boolean {
  const code = character.charCodeAt(0);
  return (
    (code < 0x20 && code !== 0x0a) ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

function readable(value: string): string {
  return Array.from(stripVTControlCharacters(value))
    .filter((character) => !unsafeTerminalControl(character))
    .join("");
}

function field(label: string, value: string): string {
  return `${label}: ${readable(value).replace(/\n/g, "\n  ")}`;
}

function responseArgv(
  request: RemoteInteractionView["request"],
  context: CommandContext,
  decision: string[]
): string[] {
  return [
    "planweave",
    "--project-root",
    context.projectRoot,
    "interaction",
    "respond",
    "--canvas",
    context.canvasId,
    "--session",
    context.sessionId,
    "--connection-profile",
    context.connectionProfileId,
    "--action",
    request.actionId,
    "--dispatch",
    request.dispatchId,
    "--lease",
    request.leaseId,
    "--attempt",
    request.executionAttemptId,
    "--acp-session",
    request.acpSessionId,
    ...decision
  ];
}

function examples(label: string, argv: string[]): string[] {
  if (argv.some((arg) => Array.from(arg).some(unsafeTerminalControl))) {
    return [
      `${label} command unavailable: an argument contains unsafe terminal control characters.`
    ];
  }
  const posix = argv.map((arg) => `'${arg.replace(/'/g, "'\\''")}'`).join(" ");
  // PowerShell recognizes these typographic single quotes as literal string delimiters too.
  const powershell = argv
    .map((arg) => `'${arg.replace(/['\u2018-\u201b]/g, (quote) => quote + quote)}'`)
    .join(" ");
  return [label, `POSIX: ${posix}`, `PowerShell: & ${powershell}`];
}

export function formatRemoteInteraction(
  { request }: RemoteInteractionView,
  context: CommandContext
): string {
  const lines = [
    field("Type", request.type),
    field("Project root", context.projectRoot),
    field("Canvas", context.canvasId),
    field("Session", context.sessionId),
    field("Connection profile", context.connectionProfileId),
    field("Action", request.actionId),
    field("Dispatch", request.dispatchId),
    field("Lease", request.leaseId),
    field("Attempt", request.executionAttemptId),
    field("ACP session", request.acpSessionId),
    field("Expires", request.expiresAt)
  ];
  switch (request.type) {
    case "interaction.permission_requested":
      lines.push(field("Title", request.title), field("Description", request.description));
      if (!("options" in request)) {
        lines.push(
          "Legacy permission request has no exact option IDs; cancel execution on the Host."
        );
        return lines.join("\n");
      }
      for (const option of request.options) {
        lines.push(
          field("Option ID", option.optionId),
          field("Label", option.label),
          field("Kind", option.kind)
        );
        lines.push(
          ...examples("Response:", responseArgv(request, context, [`--option=${option.optionId}`]))
        );
      }
      break;
    case "interaction.elicitation_requested":
      lines.push(field("Prompt", request.prompt));
      for (const option of request.options) {
        lines.push(field("Option", option));
        lines.push(
          ...examples("Response:", responseArgv(request, context, [`--option=${option}`]))
        );
      }
      if (request.options.length === 0)
        lines.push("No options advertised; provide input on the Host or cancel this request.");
      break;
    case "interaction.authentication_required":
      lines.push(
        field("Agent profile", request.agentProfileId),
        field("Host instruction", request.hostInstruction)
      );
      lines.push(
        "After signing in on the Host, retry with --option retry_after_host_login. This is a retry marker, not a permission option."
      );
      lines.push(
        ...examples(
          "Retry after Host login:",
          responseArgv(request, context, ["--option=retry_after_host_login"])
        )
      );
      break;
    default: {
      const exhaustive: never = request;
      return exhaustive;
    }
  }
  lines.push(...examples("Cancel:", responseArgv(request, context, ["--cancel"])));
  return lines.join("\n");
}
