import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { canvasVisibilitySchema } from "@planweave-ai/collaboration-protocol/access/project";
import {
  workspaceCanvasPublishOperationIdSchema,
  workspaceCanvasPublishRecoveryTokenSchema
} from "@planweave-ai/collaboration-protocol/content/version";
import { z } from "zod";
import { desktopHomePaths } from "../planweaveHomePaths.js";

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const workspaceCanvasPublishReceiptKeySchema = z
  .object({
    serverOrigin: z.string().url(),
    projectId: identifierSchema,
    localProjectId: identifierSchema,
    localCanvasId: identifierSchema
  })
  .strict();
export type WorkspaceCanvasPublishReceiptKey = z.infer<
  typeof workspaceCanvasPublishReceiptKeySchema
>;

const pendingReceiptSchema = workspaceCanvasPublishReceiptKeySchema.extend({
  status: z.literal("pending"),
  operationId: workspaceCanvasPublishOperationIdSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

const committedReceiptSchema = workspaceCanvasPublishReceiptKeySchema.extend({
  status: z.literal("committed"),
  operationId: workspaceCanvasPublishOperationIdSchema,
  recoveryToken: workspaceCanvasPublishRecoveryTokenSchema,
  workspaceId: identifierSchema,
  canvasId: identifierSchema,
  visibility: canvasVisibilitySchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export const workspaceCanvasPublishReceiptSchema = z.discriminatedUnion("status", [
  pendingReceiptSchema.strict(),
  committedReceiptSchema.strict()
]);
export type WorkspaceCanvasPublishReceipt = z.infer<typeof workspaceCanvasPublishReceiptSchema>;

const documentSchema = z
  .object({
    version: z.literal(1),
    receipts: z.array(workspaceCanvasPublishReceiptSchema).max(10_000)
  })
  .strict();

export type WorkspaceCanvasPublishReceiptStorePort = {
  find(key: WorkspaceCanvasPublishReceiptKey): Promise<WorkspaceCanvasPublishReceipt | null>;
  rememberPending(
    input: WorkspaceCanvasPublishReceiptKey & { operationId: string }
  ): Promise<WorkspaceCanvasPublishReceipt>;
  commit(
    input: WorkspaceCanvasPublishReceiptKey & {
      operationId: string;
      recoveryToken: string;
      workspaceId: string;
      canvasId: string;
      visibility: "private" | "shared";
    }
  ): Promise<WorkspaceCanvasPublishReceipt>;
};

const writeLocks = new Map<string, Promise<void>>();

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function receiptKey(input: WorkspaceCanvasPublishReceiptKey): WorkspaceCanvasPublishReceiptKey {
  return workspaceCanvasPublishReceiptKeySchema.parse({
    serverOrigin: input.serverOrigin,
    projectId: input.projectId,
    localProjectId: input.localProjectId,
    localCanvasId: input.localCanvasId
  });
}

function sameKey(
  left: WorkspaceCanvasPublishReceiptKey,
  right: WorkspaceCanvasPublishReceiptKey
): boolean {
  return (
    left.serverOrigin === right.serverOrigin &&
    left.projectId === right.projectId &&
    left.localProjectId === right.localProjectId &&
    left.localCanvasId === right.localCanvasId
  );
}

async function withWriteLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  const previous = writeLocks.get(path) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => gate);
  writeLocks.set(path, queued);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (writeLocks.get(path) === queued) writeLocks.delete(path);
  }
}

/** Main-only mapping from a local canvas source to its Workspace publish receipt. */
export class WorkspaceCanvasPublishReceiptStore implements WorkspaceCanvasPublishReceiptStorePort {
  constructor(
    private readonly path: string = desktopHomePaths()
      .collaborationWorkspaceCanvasPublishReceiptsFile
  ) {}

  async find(
    input: WorkspaceCanvasPublishReceiptKey
  ): Promise<WorkspaceCanvasPublishReceipt | null> {
    const key = receiptKey(input);
    const document = await this.read();
    return document.receipts.find((receipt) => sameKey(receipt, key)) ?? null;
  }

  async rememberPending(
    input: WorkspaceCanvasPublishReceiptKey & { operationId: string }
  ): Promise<WorkspaceCanvasPublishReceipt> {
    const key = receiptKey(input);
    const operationId = workspaceCanvasPublishOperationIdSchema.parse(input.operationId);
    return withWriteLock(this.path, async () => {
      const document = await this.read();
      const existing = document.receipts.find((receipt) => sameKey(receipt, key));
      if (existing?.status === "committed") return existing;
      const now = new Date().toISOString();
      const pending = workspaceCanvasPublishReceiptSchema.parse({
        status: "pending",
        ...key,
        operationId: existing?.operationId ?? operationId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      });
      await this.write(this.upsert(document.receipts, pending));
      return pending;
    });
  }

  async commit(
    input: WorkspaceCanvasPublishReceiptKey & {
      operationId: string;
      recoveryToken: string;
      workspaceId: string;
      canvasId: string;
      visibility: "private" | "shared";
    }
  ): Promise<WorkspaceCanvasPublishReceipt> {
    const key = receiptKey(input);
    const now = new Date().toISOString();
    return withWriteLock(this.path, async () => {
      const document = await this.read();
      const existing = document.receipts.find((receipt) => sameKey(receipt, key));
      const committed = workspaceCanvasPublishReceiptSchema.parse({
        status: "committed",
        ...key,
        operationId: workspaceCanvasPublishOperationIdSchema.parse(input.operationId),
        recoveryToken: input.recoveryToken,
        workspaceId: input.workspaceId,
        canvasId: input.canvasId,
        visibility: input.visibility,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      });
      await this.write(this.upsert(document.receipts, committed));
      return committed;
    });
  }

  private upsert(
    receipts: WorkspaceCanvasPublishReceipt[],
    next: WorkspaceCanvasPublishReceipt
  ): WorkspaceCanvasPublishReceipt[] {
    const index = receipts.findIndex((receipt) => sameKey(receipt, next));
    return index >= 0
      ? receipts.map((receipt, receiptIndex) => (receiptIndex === index ? next : receipt))
      : [...receipts, next];
  }

  private async read(): Promise<z.infer<typeof documentSchema>> {
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8"));
      return documentSchema.parse(raw);
    } catch (error) {
      if (isMissing(error)) return { version: 1, receipts: [] };
      throw new Error("workspace_canvas_publish_receipt_store_invalid", { cause: error });
    }
  }

  private async write(receipts: WorkspaceCanvasPublishReceipt[]): Promise<void> {
    const document = documentSchema.parse({ version: 1, receipts });
    const parent = dirname(this.path);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await rename(temporaryPath, this.path);
    if (((await stat(this.path)).mode & 0o777) !== 0o600) await chmod(this.path, 0o600);
  }
}
