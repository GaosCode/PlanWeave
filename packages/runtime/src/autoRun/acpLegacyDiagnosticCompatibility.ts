import { z } from "zod";
import type { NormalizedRunnerEvent } from "./normalizedEventContract.js";

const metaSchema = z.record(z.string(), z.unknown()).nullish().optional();
const contentBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }).passthrough(),
  z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }).passthrough(),
  z.object({ type: z.literal("audio"), data: z.string(), mimeType: z.string() }).passthrough(),
  z.object({ type: z.literal("resource_link"), name: z.string(), uri: z.string() }).passthrough(),
  z.object({ type: z.literal("resource"), resource: z.object({ uri: z.string() }).passthrough() }).passthrough()
]);
const availableCommandSchema = z.object({
  name: z.string(),
  description: z.string(),
  input: z.object({ hint: z.string(), _meta: metaSchema }).passthrough().nullish().optional(),
  _meta: metaSchema
}).passthrough();
const selectOptionSchema = z.object({ value: z.string(), name: z.string() }).passthrough();
const selectGroupSchema = z.object({
  group: z.string(),
  name: z.string(),
  options: z.array(selectOptionSchema)
}).passthrough();
const configOptionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("select"), id: z.string(), name: z.string(), currentValue: z.string(),
    options: z.union([z.array(selectOptionSchema), z.array(selectGroupSchema)])
  }).passthrough(),
  z.object({
    type: z.literal("boolean"), id: z.string(), name: z.string(), currentValue: z.boolean()
  }).passthrough()
]);

// These shapes mirror the generated ACP SessionUpdate schemas, but intentionally use strict
// array members: generated vecSkipError would otherwise turn a malformed historical member into
// a valid empty array and hide a real compatibility failure.
const legacyIgnoredSessionUpdateSchema = z.discriminatedUnion("sessionUpdate", [
  z.object({
    sessionUpdate: z.literal("available_commands_update"),
    availableCommands: z.array(availableCommandSchema)
  }).passthrough(),
  z.object({ sessionUpdate: z.literal("current_mode_update"), currentModeId: z.string() }).passthrough(),
  z.object({
    sessionUpdate: z.literal("config_option_update"),
    configOptions: z.array(configOptionSchema)
  }).passthrough(),
  z.object({
    sessionUpdate: z.literal("session_info_update"),
    title: z.string().nullish().optional(),
    updatedAt: z.string().nullish().optional(),
    _meta: metaSchema
  }).passthrough(),
  z.object({
    sessionUpdate: z.literal("agent_thought_chunk"),
    content: contentBlockSchema,
    messageId: z.string().nullish().optional(),
    _meta: metaSchema
  }).passthrough(),
  z.object({ sessionUpdate: z.literal("plan_removed"), planId: z.string() }).passthrough()
]);

export function isLegacyUnsupportedSessionUpdateDiagnostic(event: NormalizedRunnerEvent): boolean {
  if (event.body.kind !== "diagnostic" || event.body.code !== "corrupt_line") return false;
  const prefix = "Unsupported ACP session update: ";
  if (!event.body.message.startsWith(prefix)) return false;
  try {
    return legacyIgnoredSessionUpdateSchema.safeParse(
      JSON.parse(event.body.message.slice(prefix.length))
    ).success;
  } catch {
    return false;
  }
}
