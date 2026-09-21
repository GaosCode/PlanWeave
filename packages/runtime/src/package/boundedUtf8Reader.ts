import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { ContentReadError, MAX_FILE_READ_BYTES } from "./contentReadPolicy.js";

export const CONTENT_READ_CHUNK_BYTES = 64 * 1024;
export type ContentReadBudget = { remainingBytes: number };
export interface ContentReadHandle {
  stat(): Promise<{ size: number }>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: null
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export function utf8Prefix(
  content: string,
  maxBytes: number
): { content: string; truncated: boolean } {
  let bytes = 0;
  let end = 0;
  for (const character of content) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += character.length;
  }
  return { content: content.slice(0, end), truncated: end < content.length };
}

export async function readBoundedUtf8File(
  path: string,
  options: {
    maxBytes: number;
    maxReadBytes?: number;
    pageBudget?: ContentReadBudget;
    signal?: AbortSignal;
    openFile?: (path: string) => Promise<ContentReadHandle>;
  }
) {
  options.signal?.throwIfAborted();
  const handle = await (options.openFile ?? ((file) => open(file, "r")))(path);
  try {
    const maxReadBytes = Math.min(options.maxReadBytes ?? MAX_FILE_READ_BYTES, MAX_FILE_READ_BYTES);
    const assertBudget = (bytes: number) => {
      if (bytes > maxReadBytes)
        throw new ContentReadError(
          "content_file_budget_exceeded",
          `File exceeds the ${maxReadBytes} byte input budget.`
        );
      if (options.pageBudget && bytes > options.pageBudget.remainingBytes)
        throw new ContentReadError(
          "content_page_budget_exceeded",
          "Package file list exceeds its page input budget."
        );
    };
    const metadata = await handle.stat();
    assertBudget(metadata.size);
    const buffer = Buffer.allocUnsafe(CONTENT_READ_CHUNK_BYTES);
    const decoder = new StringDecoder("utf8");
    const hash = createHash("sha256");
    let inputBytes = 0;
    let sizeBytes = 0;
    let content = "";
    let retainedBytes = 0;
    let prefixComplete = false;
    let preview = "";
    let previewComplete = false;
    let pendingSpace = false;
    const consume = (text: string) => {
      hash.update(text, "utf8");
      sizeBytes += Buffer.byteLength(text, "utf8");
      if (!prefixComplete) {
        const prefix = utf8Prefix(text, options.maxBytes - retainedBytes);
        content += prefix.content;
        retainedBytes += Buffer.byteLength(prefix.content, "utf8");
        prefixComplete = prefix.truncated;
      }
      if (!previewComplete)
        for (const character of text) {
          if (/\s/u.test(character)) {
            pendingSpace = preview.length > 0;
            continue;
          }
          const addition = (pendingSpace ? " " : "") + character;
          if (preview.length + addition.length > 220) {
            if (pendingSpace && preview.length < 220) preview += " ";
            previewComplete = true;
            break;
          }
          preview += addition;
          pendingSpace = false;
        }
    };
    while (true) {
      options.signal?.throwIfAborted();
      const remaining =
        Math.min(maxReadBytes, options.pageBudget?.remainingBytes ?? maxReadBytes) - inputBytes;
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, remaining + 1),
        null
      );
      options.signal?.throwIfAborted();
      if (bytesRead === 0) break;
      inputBytes += bytesRead;
      assertBudget(inputBytes);
      consume(decoder.write(buffer.subarray(0, bytesRead)));
    }
    consume(decoder.end());
    if (options.pageBudget) options.pageBudget.remainingBytes -= inputBytes;
    return {
      content,
      truncated: sizeBytes > retainedBytes,
      preview,
      hash: `sha256:${hash.digest("hex")}`,
      sizeBytes,
      physicalSizeBytes: metadata.size,
      inputBytes
    };
  } finally {
    await handle.close();
  }
}
