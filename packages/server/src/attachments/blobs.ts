import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class BlobStore {
  private readonly blobsDirectory: string;
  private readonly stagedDirectory: string;
  constructor(public readonly dataDirectory: string) {
    this.blobsDirectory = join(dataDirectory, "blobs");
    this.stagedDirectory = join(dataDirectory, "attachments", "staged");
  }
  ensureDirectories(): void {
    mkdirSync(this.blobsDirectory, { recursive: true });
    mkdirSync(this.stagedDirectory, { recursive: true });
  }
  stagedPathFor(id: string): string {
    return join(this.stagedDirectory, `${id}.bin`);
  }
  canonicalPathFor(digest: string): string {
    return join(this.blobsDirectory, digest);
  }
  readAndHash(stagedPath: string): { bytes: Buffer; digest: string; size: number } {
    const bytes = readFileSync(stagedPath);
    const digest = createHash("sha256").update(bytes).digest("hex");
    return { bytes, digest, size: bytes.length };
  }
  exists(path: string): boolean {
    try { return statSync(path).isFile(); } catch { return false; }
  }
  promote(stagedPath: string, digest: string): { canonicalPath: string; promoted: boolean } {
    const canonicalPath = this.canonicalPathFor(digest);
    if (this.exists(canonicalPath)) return { canonicalPath, promoted: false };
    renameSync(stagedPath, canonicalPath);
    return { canonicalPath, promoted: true };
  }
  removeStaged(stagedPath: string): void {
    if (this.exists(stagedPath)) rmSync(stagedPath, { force: true });
  }
  writeStaged(stagedPath: string, bytes: Buffer): void {
    mkdirSync(this.stagedDirectory, { recursive: true });
    writeFileSync(stagedPath, bytes);
  }
}
