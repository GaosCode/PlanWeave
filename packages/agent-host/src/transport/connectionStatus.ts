import { randomBytes } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { HostTransportStatus } from "./hostTransport.js";

export const hostConnectionStatusPath = (dataDirectory: string): string =>
  join(dataDirectory, "connection-status.json");

const hostConnectionTransportSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("connecting"), attempt: z.number().int().positive() }).strict(),
  z.object({ state: z.literal("connected"), connectedAt: z.string().datetime() }).strict(),
  z.object({ state: z.literal("degraded"), reason: z.string().min(1).max(256) }).strict(),
  z
    .object({
      state: z.literal("reconciliation-required"),
      reason: z.string().min(1).max(256)
    })
    .strict(),
  z
    .object({
      state: z.literal("backing-off"),
      attempt: z.number().int().positive(),
      delayMs: z.number().int().nonnegative(),
      retryAt: z.string().datetime()
    })
    .strict(),
  z.object({ state: z.literal("auth-failed"), reason: z.string().min(1).max(256) }).strict(),
  z.object({ state: z.literal("stopped") }).strict()
]);

export const hostConnectionStatusDocumentSchema = z
  .object({
    version: z.literal("agent-host-connection-status/v1"),
    updatedAt: z.string().datetime(),
    transport: hostConnectionTransportSchema
  })
  .strict();

export type HostConnectionStatusDocument = z.infer<typeof hostConnectionStatusDocumentSchema>;

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function serializeHostTransportStatus(
  status: HostTransportStatus
): HostConnectionStatusDocument["transport"] {
  switch (status.state) {
    case "connecting":
      return { state: "connecting", attempt: status.attempt };
    case "connected":
      return { state: "connected", connectedAt: status.connectedAt };
    case "degraded":
      return { state: "degraded", reason: status.reason.slice(0, 256) };
    case "reconciliation-required":
      return { state: "reconciliation-required", reason: status.reason.slice(0, 256) };
    case "backing-off":
      return {
        state: "backing-off",
        attempt: status.attempt,
        delayMs: status.delayMs,
        retryAt: status.retryAt
      };
    case "auth-failed":
      return { state: "auth-failed", reason: status.reason.slice(0, 256) };
    case "stopped":
      return { state: "stopped" };
  }
}

export async function writeHostConnectionStatus(
  dataDirectory: string,
  status: HostTransportStatus,
  now = new Date()
): Promise<HostConnectionStatusDocument> {
  const document = hostConnectionStatusDocumentSchema.parse({
    version: "agent-host-connection-status/v1",
    updatedAt: now.toISOString(),
    transport: serializeHostTransportStatus(status)
  });
  const path = hostConnectionStatusPath(dataDirectory);
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch (cleanupError) {
      if (!missing(cleanupError)) {
        throw new AggregateError(
          [error, cleanupError],
          "agent_host_connection_status_write_failed"
        );
      }
    }
    throw error;
  }
  return document;
}

export async function readHostConnectionStatus(
  dataDirectory: string
): Promise<HostConnectionStatusDocument | null> {
  try {
    return hostConnectionStatusDocumentSchema.parse(
      JSON.parse(await readFile(hostConnectionStatusPath(dataDirectory), "utf8"))
    );
  } catch (error) {
    if (missing(error)) return null;
    if (error instanceof z.ZodError) return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}
