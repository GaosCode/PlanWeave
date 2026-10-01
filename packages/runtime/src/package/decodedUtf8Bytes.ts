import { open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

const INVENTORY_CHUNK_BYTES = 64 * 1024;

export async function readDecodedUtf8Bytes(path: string): Promise<number> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(INVENTORY_CHUNK_BYTES);
    const decoder = new StringDecoder("utf8");
    let contentBytes = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      contentBytes += Buffer.byteLength(decoder.write(buffer.subarray(0, bytesRead)), "utf8");
    }
    return contentBytes + Buffer.byteLength(decoder.end(), "utf8");
  } finally {
    await handle.close();
  }
}
