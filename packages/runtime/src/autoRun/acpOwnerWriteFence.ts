import { constants } from "node:fs";
import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { withAdvisoryDirectoryLock } from "../fs/advisoryDirectoryLock.js";

const claimSchema = z
  .object({
    version: z.literal("planweave.acp-owner-reconciliation/v1"),
    ownerLeaseId: z.string().uuid(),
    ownerGeneration: z.number().int().positive(),
    claimedAt: z.string().datetime()
  })
  .strict();

export class AcpOwnerWriteFencedError extends Error {
  constructor() {
    super("ACP owner writes were fenced by canonical orphan reconciliation.");
  }
}

export class AcpOwnerWriteFence {
  private readonly claimPath: string;
  private readonly lockPath: string;

  constructor(
    private readonly runDir: string,
    private readonly ownerLeaseId: string,
    private readonly ownerGeneration: number
  ) {
    this.claimPath = join(runDir, "reconciliation-claim.json");
    this.lockPath = join(runDir, ".owner-write.lock");
  }

  async withOwnerWrite<T>(operation: () => Promise<T>): Promise<T> {
    return withAdvisoryDirectoryLock(
      { lockPath: this.lockPath, operation: "acp-owner-terminal-write" },
      async () => {
        if (await this.hasClaim()) throw new AcpOwnerWriteFencedError();
        return operation();
      }
    );
  }

  async isClaimed(): Promise<boolean> {
    return this.hasClaim();
  }

  async claimAfter(revalidate: () => Promise<boolean>, claimedAt: string): Promise<boolean> {
    await mkdir(this.runDir, { recursive: true });
    return withAdvisoryDirectoryLock(
      { lockPath: this.lockPath, operation: "acp-orphan-reconciliation" },
      async () => {
        if (await this.hasClaim()) return true;
        if (!(await revalidate())) return false;
        const handle = await open(
          this.claimPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
          0o600
        );
        try {
          await handle.writeFile(
            `${JSON.stringify(
              claimSchema.parse({
                version: "planweave.acp-owner-reconciliation/v1",
                ownerLeaseId: this.ownerLeaseId,
                ownerGeneration: this.ownerGeneration,
                claimedAt
              }),
              null,
              2
            )}\n`,
            "utf8"
          );
          await handle.sync();
        } finally {
          await handle.close();
        }
        return true;
      }
    );
  }

  private async hasClaim(): Promise<boolean> {
    try {
      const claim = claimSchema.parse(
        JSON.parse(await readFile(this.claimPath, "utf8")) as unknown
      );
      if (
        claim.ownerLeaseId !== this.ownerLeaseId ||
        claim.ownerGeneration !== this.ownerGeneration
      ) {
        throw new Error("ACP reconciliation claim does not match the persisted owner identity.");
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
}
