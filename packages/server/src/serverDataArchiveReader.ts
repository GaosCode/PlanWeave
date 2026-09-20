import { createReadStream } from "node:fs";
import { Transform, Writable, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import {
  ArchivePaths,
  archiveInvalid,
  assertArchiveLimit,
  SERVER_DATA_ARCHIVE_LIMITS,
  serverDataArchiveManifestSchema,
  shouldSkipArchivePath,
  type ServerDataArchiveLimits,
  type ServerDataArchiveManifest
} from "./serverDataArchivePolicy.js";

export interface ArchiveMemberSink {
  write(chunk: Buffer): Promise<void>;
  close(): Promise<void>;
}

function textField(header: Buffer, start: number, length: number): string {
  const field = header.subarray(start, start + length);
  const zero = field.indexOf(0);
  if (zero >= 0 && field.subarray(zero).some((byte) => byte !== 0)) archiveInvalid();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      zero < 0 ? field : field.subarray(0, zero)
    );
  } catch {
    return archiveInvalid();
  }
}
function octal(header: Buffer, start: number, length: number): number {
  if (start === 124 && header[start] === 0x80) {
    if (header.subarray(start + 1, start + length - 8).some((byte) => byte !== 0)) archiveInvalid();
    const value = Number(header.readBigUInt64BE(start + length - 8));
    if (!Number.isSafeInteger(value)) archiveInvalid();
    return value;
  }
  const text = header.subarray(start, start + length).toString("latin1");
  if (!/^ *[0-7]+[\0 ]*$/.test(text)) archiveInvalid();
  const digits = text.replace(/[\0 ]+$/g, "").trim();
  if (!digits) archiveInvalid();
  const value = Number.parseInt(digits, 8);
  if (!Number.isSafeInteger(value)) archiveInvalid();
  return value;
}

export async function readServerDataArchive(input: {
  archivePath?: string;
  source?: Readable;
  limits?: ServerDataArchiveLimits;
  signal?: AbortSignal;
  openMember?: (relativePath: string) => Promise<ArchiveMemberSink>;
}): Promise<ServerDataArchiveManifest> {
  const limits = input.limits ?? SERVER_DATA_ARCHIVE_LIMITS;
  const paths = new ArchivePaths();
  let compressed = 0,
    expanded = 0,
    count = 0,
    total = 0;
  let header = Buffer.alloc(0),
    remaining = 0,
    padding = 0,
    zeros = 0;
  let manifestSeen = false,
    manifest: ServerDataArchiveManifest | undefined;
  let manifestChunks: Buffer[] | undefined, sink: ArchiveMemberSink | undefined;
  const closeMember = async () => {
    if (sink) {
      const current = sink;
      sink = undefined;
      await current.close();
    }
    if (manifestChunks) {
      const bytes = Buffer.concat(manifestChunks);
      manifestChunks = undefined;
      manifest = serverDataArchiveManifestSchema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
      );
    }
  };
  const consume = async (chunk: Buffer) => {
    expanded += chunk.length;
    assertArchiveLimit(expanded, limits.expandedBytes);
    let offset = 0;
    while (offset < chunk.length) {
      if (remaining > 0) {
        const length = Math.min(remaining, chunk.length - offset);
        const body = chunk.subarray(offset, offset + length);
        if (manifestChunks) manifestChunks.push(Buffer.from(body));
        else {
          total += length;
          if (sink) await sink.write(body);
        }
        offset += length;
        remaining -= length;
        if (remaining === 0) await closeMember();
      } else if (padding > 0) {
        const length = Math.min(padding, chunk.length - offset);
        if (chunk.subarray(offset, offset + length).some((byte) => byte !== 0)) archiveInvalid();
        offset += length;
        padding -= length;
      } else {
        const length = Math.min(512 - header.length, chunk.length - offset);
        header = Buffer.concat([header, chunk.subarray(offset, offset + length)]);
        offset += length;
        if (header.length !== 512) continue;
        const block = header;
        header = Buffer.alloc(0);
        if (block.every((byte) => byte === 0)) {
          zeros++;
          continue;
        }
        if (zeros > 0) archiveInvalid();
        const checksum = octal(block, 148, 8);
        let sum = 0;
        for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : block[i]!;
        if (
          sum !== checksum ||
          ![0, 48].includes(block[156]!) ||
          textField(block, 157, 100) !== "" ||
          textField(block, 345, 155) !== "" ||
          block.subarray(257, 263).toString("latin1") !== "ustar\0" ||
          block.subarray(263, 265).toString("ascii") !== "00"
        )
          archiveInvalid();
        for (const [start, length] of [
          [100, 8],
          [108, 8],
          [116, 8],
          [136, 12]
        ] as const) {
          octal(block, start, length);
        }
        const name = textField(block, 0, 100);
        remaining = octal(block, 124, 12);
        padding = (512 - (remaining % 512)) % 512;
        if (name === "manifest.json") {
          if (manifestSeen) archiveInvalid();
          manifestSeen = true;
          assertArchiveLimit(remaining, limits.manifestBytes);
          manifestChunks = [];
        } else {
          if (!name.startsWith("data/")) archiveInvalid();
          const path = name.slice(5);
          paths.add(path);
          if (shouldSkipArchivePath(path)) archiveInvalid();
          assertArchiveLimit(remaining, limits.fileBytes);
          count++;
          assertArchiveLimit(count, limits.fileCount);
          if (input.openMember) sink = await input.openMember(path);
        }
        if (remaining === 0) await closeMember();
      }
    }
  };
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      compressed += chunk.length;
      try {
        assertArchiveLimit(compressed, limits.compressedBytes);
        callback(null, chunk);
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });
  let pending: Promise<void> = Promise.resolve();
  const consumer = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      pending = consume(chunk);
      pending.then(
        () => callback(),
        (error) => callback(error)
      );
    }
  });
  const source = input.source ?? createReadStream(input.archivePath ?? archiveInvalid());
  try {
    await pipeline(source, counter, createGunzip({ chunkSize: 64 * 1024 }), consumer, {
      signal: input.signal
    });
    if (
      remaining ||
      padding ||
      header.length ||
      zeros < 2 ||
      !manifest ||
      manifest.fileCount !== count ||
      manifest.totalBytes !== total
    )
      archiveInvalid();
    return manifest;
  } catch (error) {
    let failure = error;
    try {
      await pending;
    } catch (consumeError) {
      if (consumeError !== error)
        failure = new AggregateError([error, consumeError], "Archive pipeline and consumer failed");
    }
    if (sink) {
      try {
        await closeMember();
      } catch (closeError) {
        throw new AggregateError([failure, closeError], "Archive read and member close failed");
      }
    }
    throw failure;
  }
}
