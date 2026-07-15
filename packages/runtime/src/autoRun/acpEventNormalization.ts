import type {
  CreateElicitationRequest,
  RequestPermissionRequest,
  SessionNotification,
  TerminalOutputRequest,
  TerminalOutputResponse
} from "@agentclientprotocol/sdk";
import { z } from "zod";
import {
  normalizedRedactedContent,
  type NormalizedRunnerEvent
} from "./normalizedEventContract.js";
import {
  acpRequestIdSchema,
  persistedPendingInteractionSchema,
  type PersistedPendingInteraction
} from "./runnerContractSchemas.js";
import { sessionConfigurationFromProtocol } from "./acpSessionConfiguration.js";

export type AcpNormalizedEventBody = NormalizedRunnerEvent["body"];

const nonConversationSessionUpdateSchema = z.discriminatedUnion("sessionUpdate", [
  z.object({ sessionUpdate: z.literal("available_commands_update") }).passthrough(),
  z.object({ sessionUpdate: z.literal("session_info_update") }).passthrough(),
  z.object({ sessionUpdate: z.literal("agent_thought_chunk") }).passthrough()
]);

export function createAcpInteractionRequestId(
  kind: PersistedPendingInteraction["kind"],
  ordinal: number
) {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
    throw new Error("ACP interaction request ordinal must be a positive safe integer.");
  }
  return acpRequestIdSchema.parse(`${kind}:${ordinal}`);
}

export function normalizeAcpPermissionHistory(
  request: RequestPermissionRequest,
  requestId: string,
  requestedAt = new Date().toISOString()
): AcpNormalizedEventBody {
  const summary = normalizedRedactedContent(
    request.toolCall.title ?? `Permission requested for ${request.toolCall.toolCallId}.`
  );
  return {
    kind: "interaction",
    interaction: persistedPendingInteractionSchema.parse({
      version: "planweave.runner/v1",
      interactionId: requestId,
      requestId,
      kind: "permission",
      requestedAt,
      summary: summary.content,
      status: "cancelled",
      actionable: false,
      nonActionableReason: "persisted_history"
    })
  };
}

export function normalizeAcpElicitationHistory(
  request: CreateElicitationRequest,
  requestId: string,
  requestedAt = new Date().toISOString()
): AcpNormalizedEventBody {
  const summary = normalizedRedactedContent(request.message);
  return {
    kind: "interaction",
    interaction: persistedPendingInteractionSchema.parse({
      version: "planweave.runner/v1",
      interactionId: requestId,
      requestId,
      kind: "elicitation",
      requestedAt,
      summary: summary.content,
      status: "cancelled",
      actionable: false,
      nonActionableReason: "persisted_history"
    })
  };
}

export function normalizeAcpTerminalOutput(
  request: TerminalOutputRequest,
  response: TerminalOutputResponse
): AcpNormalizedEventBody {
  const content = normalizedRedactedContent(response.output);
  return { kind: "terminal_output", terminalId: request.terminalId, ...content };
}

function serialized(value: unknown): ReturnType<typeof normalizedRedactedContent> {
  return normalizedRedactedContent(typeof value === "string" ? value : JSON.stringify(value));
}

function textContent(value: unknown): ReturnType<typeof normalizedRedactedContent> {
  if (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "text" &&
    "text" in value
  ) {
    return normalizedRedactedContent(String(value.text));
  }
  return serialized(value);
}

function toolStatus(
  value: unknown
): "pending" | "in_progress" | "completed" | "failed" | "cancelled" | null {
  return value === "pending" ||
    value === "in_progress" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
    ? value
    : null;
}

function optionalSerialized(value: unknown, present: boolean) {
  return present ? serialized(value) : undefined;
}

export function normalizeAcpSessionNotification(
  notification: SessionNotification
): AcpNormalizedEventBody | null {
  const update = notification.update;
  if (nonConversationSessionUpdateSchema.safeParse(update).success) return null;
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
    case "user_message_chunk": {
      const content = textContent(update.content);
      return {
        kind: "message",
        role: update.sessionUpdate === "agent_message_chunk" ? "assistant" : "user",
        messageId: update.messageId ?? null,
        chunk: true,
        ...content
      };
    }
    case "tool_call": {
      const title = normalizedRedactedContent(update.title);
      return {
        kind: "tool_call",
        callId: update.toolCallId,
        status: toolStatus(update.status),
        title: title.content,
        toolKind: update.kind ?? null,
        content: update.content ? serialized(update.content) : null,
        rawInput: Object.hasOwn(update, "rawInput") ? serialized(update.rawInput) : null,
        rawOutput: Object.hasOwn(update, "rawOutput") ? serialized(update.rawOutput) : null
      };
    }
    case "tool_call_update": {
      const status = Object.hasOwn(update, "status") ? toolStatus(update.status) : undefined;
      const title = Object.hasOwn(update, "title")
        ? typeof update.title === "string"
          ? normalizedRedactedContent(update.title).content
          : null
        : undefined;
      const toolKind = Object.hasOwn(update, "kind") ? (update.kind ?? null) : undefined;
      const content = Object.hasOwn(update, "content")
        ? update.content === null
          ? null
          : serialized(update.content)
        : undefined;
      return {
        kind: "tool_update",
        callId: update.toolCallId,
        ...(status !== undefined ? { status } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(toolKind !== undefined ? { toolKind } : {}),
        ...(content !== undefined || update.content === null ? { content } : {}),
        ...(Object.hasOwn(update, "rawInput")
          ? { rawInput: optionalSerialized(update.rawInput, true) }
          : {}),
        ...(Object.hasOwn(update, "rawOutput")
          ? { rawOutput: optionalSerialized(update.rawOutput, true) }
          : {})
      };
    }
    case "plan":
    case "plan_update": {
      const content = serialized(update.sessionUpdate === "plan" ? update : update.plan);
      return { kind: "plan_update", ...content };
    }
    case "plan_removed":
      return { kind: "plan_update", ...normalizedRedactedContent("Plan removed.") };
    case "usage_update":
      return {
        kind: "usage_update",
        usedTokens: update.used,
        contextWindowTokens: update.size,
        cost: update.cost ? { amount: update.cost.amount, currency: update.cost.currency } : null
      };
    case "current_mode_update":
      return { kind: "session_mode_update", currentModeId: update.currentModeId };
    case "config_option_update":
      return {
        kind: "session_config_options_update",
        configOptions: sessionConfigurationFromProtocol({
          modes: null,
          configOptions: update.configOptions
        }).configOptions
      };
    default: {
      const content = serialized(update);
      return {
        kind: "diagnostic",
        code: "corrupt_line",
        message: `Unsupported ACP session update: ${content.content}`
      };
    }
  }
}
