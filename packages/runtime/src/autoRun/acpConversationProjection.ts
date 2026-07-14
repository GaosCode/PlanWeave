import { z } from "zod";
import type { NormalizedRunnerEvent } from "./normalizedEventContract.js";
import { artifactReferenceSchema } from "./runnerContractSchemas.js";

export const acpConversationItemSchema = z
  .object({
    sequence: z.number().int().positive(),
    timestamp: z.string().datetime(),
    kind: z.enum([
      "message",
      "tool_call",
      "tool_update",
      "plan_update",
      "terminal_output",
      "output"
    ]),
    role: z.enum(["assistant", "user"]).optional(),
    content: z.string()
  })
  .strict();
export type AcpConversationItem = z.infer<typeof acpConversationItemSchema>;

const timelineBaseSchema = z.object({
  sequence: z.number().int().positive(),
  timestamp: z.string().datetime()
});
export const acpTimelineItemSchema = z.discriminatedUnion("kind", [
  timelineBaseSchema.extend({
    kind: z.literal("message"),
    role: z.enum(["assistant", "user"]),
    content: z.string()
  }).strict(),
  timelineBaseSchema.extend({
    kind: z.literal("tool"),
    callId: z.string().min(1),
    title: z.string(),
    toolKind: z.string().nullable(),
    status: z.enum(["pending", "in_progress", "completed", "failed", "cancelled"]).nullable(),
    input: z.string().nullable(),
    output: z.string().nullable()
  }).strict(),
  timelineBaseSchema.extend({ kind: z.literal("plan"), content: z.string() }).strict(),
  timelineBaseSchema.extend({
    kind: z.literal("artifact"),
    artifact: artifactReferenceSchema
  }).strict(),
  timelineBaseSchema.extend({
    kind: z.literal("output"),
    stream: z.enum(["stdout", "stderr", "terminal"]),
    content: z.string()
  }).strict()
]);
export type AcpTimelineItem = z.infer<typeof acpTimelineItemSchema>;

function projectionItem(event: NormalizedRunnerEvent): AcpConversationItem | null {
  const body = event.body;
  if (body.kind === "message") return { sequence: event.sequence, timestamp: event.timestamp, kind: body.kind, role: body.role, content: body.content };
  if (body.kind === "tool_call") return { sequence: event.sequence, timestamp: event.timestamp, kind: body.kind, content: `${body.title}${body.content ? `\n${body.content.content}` : ""}` };
  if (body.kind === "tool_update") return { sequence: event.sequence, timestamp: event.timestamp, kind: body.kind, content: body.content?.content ?? body.status ?? "updated" };
  if (body.kind === "plan_update" || body.kind === "terminal_output" || body.kind === "output") return { sequence: event.sequence, timestamp: event.timestamp, kind: body.kind, content: body.content };
  return null;
}

export class AcpProjectionAccumulator {
  private readonly conversationItems: AcpConversationItem[] = [];
  private conversationMessage: { index: number; role: "assistant" | "user"; messageId: string | null } | null = null;
  private readonly timelineItems: AcpTimelineItem[] = [];
  private readonly tools = new Map<string, {
    index: number;
    titleSet: boolean;
    kindSet: boolean;
    statusSet: boolean;
    inputSet: boolean;
    outputSet: boolean;
  }>();
  private timelineMessage: { index: number; role: "assistant" | "user"; messageId: string | null } | null = null;

  append(event: NormalizedRunnerEvent): void {
    const item = projectionItem(event);
    if (item !== null) {
      if (event.body.kind !== "message") {
        this.conversationItems.push(item);
        this.conversationMessage = null;
      } else if (this.conversationMessage !== null &&
        this.conversationMessage.role === event.body.role &&
        ((this.conversationMessage.messageId === null && event.body.messageId === null) ||
          (this.conversationMessage.messageId !== null && this.conversationMessage.messageId === event.body.messageId)) &&
        event.body.chunk) {
        const previous = this.conversationItems[this.conversationMessage.index];
        if (!previous) throw new Error("ACP conversation message projection index is invalid.");
        this.conversationItems[this.conversationMessage.index] = { ...previous, content: previous.content + item.content };
      } else {
        this.conversationItems.push(item);
        this.conversationMessage = event.body.chunk
          ? { index: this.conversationItems.length - 1, role: event.body.role, messageId: event.body.messageId }
          : null;
      }
    }

    const body = event.body;
    if (body.kind === "message") {
      if (this.timelineMessage && this.timelineMessage.role === body.role && body.chunk &&
        ((this.timelineMessage.messageId === null && body.messageId === null) || this.timelineMessage.messageId === body.messageId)) {
        const previous = this.timelineItems[this.timelineMessage.index];
        if (!previous || previous.kind !== "message") throw new Error("ACP timeline message index is invalid.");
        this.timelineItems[this.timelineMessage.index] = { ...previous, content: previous.content + body.content };
      } else {
        this.timelineItems.push({ sequence: event.sequence, timestamp: event.timestamp, kind: "message", role: body.role, content: body.content });
        this.timelineMessage = body.chunk ? { index: this.timelineItems.length - 1, role: body.role, messageId: body.messageId } : null;
      }
      return;
    }
    this.timelineMessage = null;
    if (body.kind === "tool_call") {
      const existing = this.tools.get(body.callId);
      const rawInput = body.rawInput?.content ?? body.content?.content ?? null;
      const rawOutput = body.rawOutput?.content ?? null;
      if (existing) {
        const previous = this.timelineItems[existing.index];
        if (!previous || previous.kind !== "tool") throw new Error("ACP timeline tool index is invalid.");
        this.timelineItems[existing.index] = {
          ...previous,
          title: existing.titleSet ? previous.title : body.title,
          toolKind: existing.kindSet ? previous.toolKind : body.toolKind ?? null,
          status: existing.statusSet ? previous.status : body.status,
          input: existing.inputSet ? previous.input : rawInput,
          output: existing.outputSet ? previous.output : rawOutput
        };
      } else {
        this.timelineItems.push({
          sequence: event.sequence, timestamp: event.timestamp, kind: "tool", callId: body.callId,
          title: body.title, toolKind: body.toolKind ?? null, status: body.status,
          input: rawInput, output: rawOutput
        });
        this.tools.set(body.callId, {
          index: this.timelineItems.length - 1,
          titleSet: true,
          kindSet: body.toolKind !== undefined,
          statusSet: true,
          inputSet: body.rawInput !== undefined || body.content !== null,
          outputSet: body.rawOutput !== undefined
        });
      }
    } else if (body.kind === "tool_update") {
      const existing = this.tools.get(body.callId);
      const hasTitle = body.title !== undefined;
      const hasKind = body.toolKind !== undefined;
      const hasStatus = body.status !== undefined;
      const hasInput = body.rawInput !== undefined;
      const hasRawOutput = body.rawOutput !== undefined;
      const hasContent = body.content !== undefined;
      const replacementOutput = hasRawOutput
        ? body.rawOutput?.content ?? null
        : hasContent
          ? body.content?.content ?? null
          : undefined;
      if (!existing) {
        this.timelineItems.push({
          sequence: event.sequence, timestamp: event.timestamp, kind: "tool", callId: body.callId,
          title: body.title ?? body.callId,
          toolKind: body.toolKind ?? null,
          status: body.status ?? null,
          input: body.rawInput?.content ?? null,
          output: replacementOutput ?? null
        });
        this.tools.set(body.callId, {
          index: this.timelineItems.length - 1,
          titleSet: hasTitle,
          kindSet: hasKind,
          statusSet: hasStatus,
          inputSet: hasInput,
          outputSet: hasRawOutput || hasContent
        });
      } else {
        const previous = this.timelineItems[existing.index];
        if (!previous || previous.kind !== "tool") throw new Error("ACP timeline tool index is invalid.");
        this.timelineItems[existing.index] = {
          ...previous,
          title: hasTitle ? body.title ?? body.callId : previous.title,
          toolKind: hasKind ? body.toolKind ?? null : previous.toolKind,
          status: hasStatus ? body.status ?? null : previous.status,
          input: hasInput ? body.rawInput?.content ?? null : previous.input,
          output: replacementOutput === undefined ? previous.output : replacementOutput
        };
        existing.titleSet ||= hasTitle;
        existing.kindSet ||= hasKind;
        existing.statusSet ||= hasStatus;
        existing.inputSet ||= hasInput;
        existing.outputSet ||= hasRawOutput || hasContent;
      }
    } else if (body.kind === "plan_update") {
      this.timelineItems.push({ sequence: event.sequence, timestamp: event.timestamp, kind: "plan", content: body.content });
    } else if (body.kind === "artifact") {
      this.timelineItems.push({
        sequence: event.sequence,
        timestamp: event.timestamp,
        kind: "artifact",
        artifact: body.artifact
      });
    } else if (body.kind === "output") {
      this.timelineItems.push({ sequence: event.sequence, timestamp: event.timestamp, kind: "output", stream: body.stream, content: body.content });
    } else if (body.kind === "terminal_output") {
      this.timelineItems.push({ sequence: event.sequence, timestamp: event.timestamp, kind: "output", stream: "terminal", content: body.content });
    }
  }

  snapshot(): { conversation: AcpConversationItem[]; timeline: AcpTimelineItem[] } {
    return {
      conversation: [...this.conversationItems],
      timeline: [...this.timelineItems]
    };
  }
}

export function projectAcpConversation(events: readonly NormalizedRunnerEvent[]): AcpConversationItem[] {
  const accumulator = new AcpProjectionAccumulator();
  for (const event of events) accumulator.append(event);
  return accumulator.snapshot().conversation;
}

export function projectAcpTimeline(events: readonly NormalizedRunnerEvent[]): AcpTimelineItem[] {
  const accumulator = new AcpProjectionAccumulator();
  for (const event of events) accumulator.append(event);
  return acpTimelineItemSchema.array().parse(accumulator.snapshot().timeline);
}
