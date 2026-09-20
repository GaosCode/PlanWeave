import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomFillSync } from "node:crypto";
import {
  exportServerDataDirectory,
  inspectServerDataArchive,
  restoreServerDataDirectory
} from "../../serverDataArchive.js";

const bytes = Number(process.argv[2]);
const entropy = process.argv[3];
if (![128 * 1024 ** 2, 1024 ** 3].includes(bytes) || !["high", "low"].includes(entropy ?? ""))
  throw new Error("Invalid resource scenario");
const root = await mkdtemp(join(tmpdir(), "archive-resource-"));
const start = performance.now();
try {
  const dataDirectory = join(root, "source");
  await mkdir(dataDirectory);
  const handle = await open(join(dataDirectory, "payload"), "wx");
  const hash = createHash("sha256");
  try {
    const chunk = Buffer.alloc(64 * 1024);
    for (let written = 0; written < bytes; written += chunk.length) {
      if (entropy === "high") randomFillSync(chunk);
      hash.update(chunk);
      await handle.writeFile(chunk);
    }
  } finally {
    await handle.close();
  }
  const expected = hash.digest("hex");
  const archivePath = join(root, "archive.tgz");
  await exportServerDataDirectory({ dataDirectory, archivePath });
  const exportedMs = performance.now() - start;
  const inspected = await inspectServerDataArchive(archivePath);
  const target = join(root, "target");
  await restoreServerDataDirectory({ dataDirectory: target, archivePath, overwrite: false });
  const restored = createHash("sha256");
  for await (const chunk of createReadStream(join(target, "payload"))) restored.update(chunk);
  const actual = restored.digest("hex");
  if (actual !== expected || inspected.totalBytes !== bytes || inspected.fileCount !== 1)
    throw new Error("Resource round-trip mismatch");
  console.log(
    JSON.stringify({
      bytes,
      entropy,
      compressedBytes: (await stat(archivePath)).size,
      sha256: actual,
      maxRssKiB: process.resourceUsage().maxRSS,
      exportMs: Math.round(exportedMs),
      elapsedMs: Math.round(performance.now() - start)
    })
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
