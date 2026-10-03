import { z } from "zod";
import { workspaceExecutionSessionStateSchema } from "../workspaceExecution/contracts.js";
import type { SchemaDocument } from "./types.js";

export const workspaceSessionSchemaDocument: SchemaDocument<"workspace-session"> = {
  name: "workspace-session",
  summary: "Durable Workspace execution checkpoint schema.",
  path: "results/run-sessions/<sessionId>/session.json workspaceExecution field",
  ownership:
    "Runtime owned. Use interaction and run-session commands; do not edit checkpoints by hand.",
  validation: ["planweave run-session <sessionId> --json"],
  schema: z.toJSONSchema(workspaceExecutionSessionStateSchema, { io: "output" }),
  notes: [
    "responseIntent is optional on an interaction record and contains the exact request and response checkpointed before remote delivery.",
    "Only the same identity and response can recover a pending responseIntent through the Server idempotent settlement contract.",
    "interaction list only synchronizes pending observations; it never sends a saved response or infers settlement from a missing item.",
    "Settled and expired records cannot become pending again."
  ]
};
