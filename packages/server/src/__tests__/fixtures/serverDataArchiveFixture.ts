import { gzipSync } from "node:zlib";

export function archiveHeader(name: string, size: number, type = "0"): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  for (const [start, length] of [
    [100, 8],
    [108, 8],
    [116, 8],
    [136, 12]
  ] as const) {
    header.write("0".repeat(length - 1), start, length - 1);
  }
  header.write(size.toString(8).padStart(11, "0"), 124, 11);
  header.fill(32, 148, 156);
  header.write(type, 156, 1);
  header.write("ustar\0", 257);
  header.write("00", 263);
  updateChecksum(header);
  return header;
}
export function updateChecksum(header: Buffer): void {
  header.fill(32, 148, 156);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
}
export function member(name: string, body: Buffer | string, type = "0"): Buffer {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return Buffer.concat([
    archiveHeader(name, bytes.length, type),
    bytes,
    Buffer.alloc((512 - (bytes.length % 512)) % 512)
  ]);
}
export function manifest(count = 1, bytes = 3): string {
  return JSON.stringify({
    schemaVersion: "planweave-server-data-archive/v1",
    exportedAt: "2030-01-01T00:00:00.000Z",
    fileCount: count,
    totalBytes: bytes
  });
}
export function tar(
  members = [member("manifest.json", manifest()), member("data/file", "abc")]
): Buffer {
  return Buffer.concat([...members, Buffer.alloc(1024)]);
}
export function archive(members?: Buffer[]): Buffer {
  return gzipSync(tar(members));
}
