// This function is serialized into an isolated worker. Keep every runtime dependency inside it.
export function tunnelArchiveWorker(require: NodeJS.Require): void {
  const { parentPort, workerData } =
    require("node:worker_threads") as typeof import("node:worker_threads");
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  const { Inflate } = require(workerData.fflatePath) as typeof import("fflate");
  const { zip, binaryName, expectedHash, maxBytes, maxEntries } = workerData as {
    zip: Uint8Array;
    binaryName: string;
    expectedHash: string;
    maxBytes: number;
    maxEntries: number;
  };
  const fail = (message: string): never => {
    throw new Error(message);
  };
  try {
    if (createHash("sha256").update(zip).digest("hex") !== expectedHash) {
      parentPort!.postMessage({
        error: "Tunnel client archive checksum does not match SHA256SUMS.txt.",
        code: "checksum_mismatch"
      });
      return;
    }
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const u16 = (offset: number) => view.getUint16(offset, true);
    const u32 = (offset: number) => view.getUint32(offset, true);
    let end = zip.length - 22;
    while (end >= Math.max(0, zip.length - 65557) && u32(end) !== 0x06054b50) end--;
    if (end < 0 || u32(end) !== 0x06054b50 || end + 22 + u16(end + 20) !== zip.length)
      fail("Invalid or truncated tunnel client ZIP directory.");
    const entries = u16(end + 10);
    if (u16(end + 4) !== 0 || u16(end + 6) !== 0 || u16(end + 8) !== entries || entries === 65535)
      fail("Unsupported tunnel client ZIP directory.");
    if (entries > maxEntries) fail("Tunnel client archive exceeds the entry limit.");
    let offset = u32(end + 16);
    if (offset + u32(end + 12) !== end) fail("Invalid tunnel client ZIP directory size.");
    let target:
      | { start: number; compressed: number; size: number; method: number; crc: number }
      | undefined;
    for (let index = 0; index < entries; index++) {
      if (offset + 46 > end || u32(offset) !== 0x02014b50)
        fail("Truncated tunnel client ZIP entry.");
      const compressed = u32(offset + 20),
        size = u32(offset + 24);
      const nameLength = u16(offset + 28),
        extraLength = u16(offset + 30),
        commentLength = u16(offset + 32);
      const next = offset + 46 + nameLength + extraLength + commentLength;
      if (next > end || compressed === 0xffffffff || size === 0xffffffff)
        fail("Invalid tunnel client ZIP entry size.");
      const name = new TextDecoder("utf-8", { fatal: true }).decode(
        zip.subarray(offset + 46, offset + 46 + nameLength)
      );
      const local = u32(offset + 42);
      if (local + 30 > u32(end + 16) || u32(local) !== 0x04034b50)
        fail("Invalid tunnel client ZIP local header.");
      const start = local + 30 + u16(local + 26) + u16(local + 28);
      if (start + compressed > u32(end + 16)) fail("Truncated tunnel client ZIP body.");
      if (name === binaryName || name.endsWith(`/${binaryName}`)) {
        if (target) fail("Tunnel client archive contains duplicate or ambiguous target binaries.");
        if (size > maxBytes) fail("Tunnel client binary exceeds the declared byte limit.");
        const method = u16(offset + 10),
          flags = u16(offset + 8);
        if (
          flags & 1 ||
          (method !== 0 && method !== 8) ||
          u16(local + 8) !== method ||
          u16(local + 6) !== flags
        )
          fail("Unsupported tunnel client ZIP target encoding.");
        const localName = new TextDecoder("utf-8", { fatal: true }).decode(
          zip.subarray(local + 30, local + 30 + u16(local + 26))
        );
        if (
          localName !== name ||
          (!(flags & 8) && (u32(local + 18) !== compressed || u32(local + 22) !== size))
        )
          fail("Inconsistent tunnel client ZIP target declaration.");
        target = { start, compressed, size, method, crc: u32(offset + 16) };
      }
      offset = next;
    }
    if (offset !== end) fail("Invalid tunnel client ZIP entry count.");
    if (!target) fail(`Tunnel client archive does not contain ${binaryName}.`);
    const selected = target!;
    const chunks: Uint8Array[] = [];
    let total = 0,
      crc = 0xffffffff,
      finished = false;
    const consume = (chunk: Uint8Array, final: boolean) => {
      total += chunk.length;
      if (total > maxBytes || total > selected.size)
        fail("Tunnel client binary exceeds its output byte limit or declared size.");
      for (const byte of chunk) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
      chunks.push(chunk);
      finished = final;
    };
    const decoder = selected.method === 8 ? new Inflate(consume) : null;
    for (let index = 0; index < selected.compressed || index === 0; index += 1024) {
      const chunk = zip.subarray(
        selected.start + index,
        selected.start + Math.min(index + 1024, selected.compressed)
      );
      const final = index + 1024 >= selected.compressed;
      if (decoder) decoder.push(chunk, final);
      else consume(chunk, final);
    }
    if (!finished || total !== selected.size || (crc ^ 0xffffffff) >>> 0 !== selected.crc)
      fail("Truncated or corrupt tunnel client binary.");
    const binary = new Uint8Array(total);
    let position = 0;
    for (const chunk of chunks) {
      binary.set(chunk, position);
      position += chunk.length;
    }
    parentPort!.postMessage(
      { binary, binarySha256: createHash("sha256").update(binary).digest("hex") },
      [binary.buffer]
    );
  } catch (error) {
    parentPort!.postMessage({
      error: error instanceof Error ? error.message : String(error),
      code: "invalid_archive"
    });
  }
}
