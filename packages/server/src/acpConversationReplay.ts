import { createHash } from "node:crypto";
import { canonicalizeJson } from "@planweave-ai/agent-host-protocol";
import { z } from "zod";
import type { SqliteDatabase } from "./sqlite.js";

const replayReceiptSchema = z
  .object({
    turn_id: z.string().min(1),
    request_digest: z.string().regex(/^[a-f0-9]{64}$/),
    final_sequence: z.number().int().nonnegative().safe(),
    last_cursor: z.number().int().nonnegative().safe()
  })
  .strict();

export function acpConversationDigest(value: unknown): string {
  return createHash("sha256").update(canonicalizeJson(value)).digest("hex");
}

export function readAcpConversationReplayReceipt(
  database: SqliteDatabase,
  turnId: string,
  finalSequence: number
) {
  const row = database
    .prepare("SELECT * FROM acp_conversation_replay_receipts WHERE turn_id=?")
    .get(turnId);
  if (!row) throw new Error("acp_conversation_replay_receipt_missing");
  const receipt = replayReceiptSchema.parse(row);
  if (receipt.final_sequence !== finalSequence)
    throw new Error("acp_conversation_replay_receipt_invalid");
  return receipt;
}
