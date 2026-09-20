import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inspectServerDataArchive,
  restoreServerDataDirectory,
  exportServerDataDirectory
} from "../serverDataArchive.js";
import { readServerDataArchive } from "../serverDataArchiveReader.js";
import { SERVER_DATA_ARCHIVE_LIMITS } from "../serverDataArchivePolicy.js";
import {
  archive,
  archiveHeader,
  manifest,
  member,
  tar,
  updateChecksum
} from "./fixtures/serverDataArchiveFixture.js";

const cleanupFailure = vi.hoisted(() => ({ enabled: false }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (cleanupFailure.enabled && String(args[0]).includes(".planweave-server-restore-"))
        throw new Error("cleanup denied");
      return actual.rm(...args);
    }
  };
});

const roots: string[] = [];
afterEach(async () => {
  cleanupFailure.enabled = false;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function root() {
  const path = await mkdtemp(join(tmpdir(), "archive-reader-"));
  roots.push(path);
  return path;
}
const headerBad = archiveHeader("data/file", 3);
headerBad[1] = 1;
const sizeBad = archiveHeader("data/file", 3);
sizeBad.write("0000000003x", 124, 11);
updateChecksum(sizeBad);
const spacedSize = archiveHeader("data/file", 0);
spacedSize.write("00000000 03", 124, 11);
updateChecksum(spacedSize);
const gzipBad = archive();
gzipBad[gzipBad.length - 8] ^= 1;
const invalid: Array<[string, Buffer]> = [
  [
    "embedded numeric whitespace",
    gzipSync(tar([member("manifest.json", manifest(1, 0)), spacedSize]))
  ],
  ["manifest schema", archive([member("manifest.json", "{}"), member("data/file", "abc")])],
  ["manifest malformed JSON", archive([member("manifest.json", "{"), member("data/file", "abc")])],
  [
    "manifest unsafe integer",
    archive([
      member("manifest.json", manifest(1, Number.MAX_SAFE_INTEGER + 1)),
      member("data/file", "abc")
    ])
  ],
  [
    "duplicate manifest",
    archive([
      member("manifest.json", manifest()),
      member("manifest.json", manifest()),
      member("data/file", "abc")
    ])
  ],
  [
    "duplicate file",
    archive([
      member("manifest.json", manifest(2, 6)),
      member("data/file", "abc"),
      member("data/file", "abc")
    ])
  ],
  ["wrong count", archive([member("manifest.json", manifest(2)), member("data/file", "abc")])],
  ["wrong bytes", archive([member("manifest.json", manifest(1, 4)), member("data/file", "abc")])],
  ["missing manifest", archive([member("data/file", "abc")])],
  ["unknown root", archive([member("manifest.json", manifest()), member("other/file", "abc")])],
  [
    "checksum",
    gzipSync(
      tar([member("manifest.json", manifest()), Buffer.concat([headerBad, Buffer.alloc(512)])])
    )
  ],
  [
    "invalid numeric",
    gzipSync(
      tar([member("manifest.json", manifest()), Buffer.concat([sizeBad, Buffer.alloc(512)])])
    )
  ],
  ["header truncated", gzipSync(Buffer.alloc(511))],
  ["body truncated", gzipSync(Buffer.concat([archiveHeader("data/file", 3), Buffer.from("ab")]))],
  [
    "padding truncated",
    gzipSync(Buffer.concat([archiveHeader("data/file", 3), Buffer.from("abc")]))
  ],
  ["missing end", gzipSync(tar().subarray(0, -1024))],
  ["one end block", gzipSync(tar().subarray(0, -512))],
  ["partial trailing block", gzipSync(Buffer.concat([tar(), Buffer.alloc(1)]))],
  ["nonzero trailing bytes", gzipSync(Buffer.concat([tar(), Buffer.alloc(512, 1)]))],
  ["gzip truncated", archive().subarray(0, -4)],
  ["gzip crc", gzipBad],
  ...["1", "2", "5", "x", "g", "L"].map(
    (type) =>
      [
        `type ${type}`,
        archive([member("manifest.json", manifest()), member("data/file", "abc", type)])
      ] as [string, Buffer]
  ),
  ...[
    "../escape",
    "/absolute",
    "C:/drive",
    "a\\b",
    "CON.txt",
    "CON .txt",
    "CONIN$",
    "CONOUT$",
    "nul",
    "a.",
    "a ",
    "a//b",
    "a/./b",
    "artifacts/tmp/file",
    "backups/file",
    ".planweave-server-restore-old/file",
    ".planweave-server-replaced-old/file"
  ].map(
    (path) =>
      [
        `path ${path}`,
        archive([member("manifest.json", manifest()), member(`data/${path}`, "abc")])
      ] as [string, Buffer]
  ),
  ...[
    ["a", "a/b"],
    ["a/b", "a"],
    ["File", "file"],
    ["Dir/a", "dir/b"],
    ["é", "e\u0301"],
    ["Σ", "ς"],
    ["straße", "STRASSE"]
  ].map(
    ([a, b]) =>
      [
        `collision ${a} ${b}`,
        archive([
          member("manifest.json", manifest(2, 6)),
          member(`data/${a}`, "abc"),
          member(`data/${b}`, "abc")
        ])
      ] as [string, Buffer]
  )
];

describe("shared archive validity", () => {
  it.each(
    invalid
  )("rejects %s in inspect and restore and preserves target", async (_name, bytes) => {
    const directory = await root();
    const path = join(directory, "archive.tgz");
    const target = join(directory, "target");
    await writeFile(path, bytes);
    await mkdir(target);
    await writeFile(join(target, "keep"), "untouched");
    await expect(inspectServerDataArchive(path)).rejects.toThrow();
    await expect(
      restoreServerDataDirectory({ archivePath: path, dataDirectory: target, overwrite: true })
    ).rejects.toThrow();
    expect(await readdir(target)).toEqual(["keep"]);
    expect(await readFile(join(target, "keep"), "utf8")).toBe("untouched");
    const emptyTarget = join(directory, "empty");
    await expect(
      restoreServerDataDirectory({
        archivePath: path,
        dataDirectory: emptyTarget,
        overwrite: false
      })
    ).rejects.toThrow();
    expect(await readdir(emptyTarget)).toEqual([]);
  });
  it("accepts split chunks, empty files and manifest after data", async () => {
    const bytes = archive([member("data/file", ""), member("manifest.json", manifest(1, 0))]);
    expect(
      await readServerDataArchive({
        source: Readable.from([...bytes].map((byte) => Buffer.from([byte])))
      })
    ).toMatchObject({ fileCount: 1, totalBytes: 0 });
  });
  it.each([
    "compressedBytes",
    "expandedBytes",
    "fileBytes",
    "fileCount",
    "manifestBytes"
  ] as const)("enforces exact %s boundary", async (key) => {
    const bytes = archive();
    const exact = {
      compressedBytes: bytes.length,
      expandedBytes: tar().length,
      fileBytes: 3,
      fileCount: 1,
      manifestBytes: Buffer.byteLength(manifest())
    }[key];
    const limits = { ...SERVER_DATA_ARCHIVE_LIMITS, [key]: exact };
    await expect(
      readServerDataArchive({ source: Readable.from([bytes]), limits })
    ).resolves.toMatchObject({ totalBytes: 3 });
    await expect(
      readServerDataArchive({
        source: Readable.from([bytes]),
        limits: { ...limits, [key]: exact - 1 }
      })
    ).rejects.toMatchObject({ code: "server_data_archive_resource_limit" });
  });
  it("rejects platform aliases during export too", async () => {
    const directory = await root();
    const data = join(directory, "data");
    await mkdir(data);
    await writeFile(join(data, "CON.txt"), "bad");
    await expect(
      exportServerDataDirectory({ dataDirectory: data, archivePath: join(directory, "out.tgz") })
    ).rejects.toMatchObject({ code: "server_data_archive_invalid" });
  });
});

describe("stream lifecycle", () => {
  it("applies backpressure to a slow member consumer", async () => {
    const bytes = archive([
      member("manifest.json", manifest(1, 2 * 1024 ** 2)),
      member("data/file", Buffer.alloc(2 * 1024 ** 2))
    ]);
    let calls = 0,
      active = 0,
      peak = 0,
      received = 0,
      closed = false;
    await readServerDataArchive({
      source: Readable.from([bytes]),
      openMember: async () => ({
        write: async (chunk) => {
          active++;
          peak = Math.max(peak, active);
          calls++;
          await new Promise((resolve) => setTimeout(resolve, 1));
          received += chunk.length;
          active--;
        },
        close: async () => {
          closed = true;
        }
      })
    });
    expect(peak).toBe(1);
    expect(calls).toBeGreaterThan(10);
    expect(received).toBe(2 * 1024 ** 2);
    expect(closed).toBe(true);
  });
  it("propagates source errors and destroys the stream", async () => {
    const source = new Readable({
      read() {
        this.destroy(new Error("source failed"));
      }
    });
    await expect(readServerDataArchive({ source })).rejects.toThrow("source failed");
    expect(source.destroyed).toBe(true);
  });
  it.each([
    "write",
    "abort"
  ])("closes member after %s and waits for pending write", async (mode) => {
    const controller = new AbortController();
    let closed = false,
      writing = false;
    const source = Readable.from([archive()]);
    await expect(
      readServerDataArchive({
        source,
        signal: controller.signal,
        openMember: async () => ({
          write: async () => {
            writing = true;
            if (mode === "abort") controller.abort();
            await new Promise((resolve) => setTimeout(resolve, 5));
            writing = false;
            if (mode === "write") throw new Error("write failed");
          },
          close: async () => {
            expect(writing).toBe(false);
            closed = true;
          }
        })
      })
    ).rejects.toThrow();
    expect(closed).toBe(true);
    expect(source.destroyed).toBe(true);
  });
});

describe("stream failure diagnostics", () => {
  it("does not read the full compressed input while a writer is stalled", async () => {
    const body = randomBytes(2 * 1024 ** 2);
    const bytes = archive([
      member("manifest.json", manifest(1, body.length)),
      member("data/file", body)
    ]);
    let pulled = 0;
    const source = Readable.from(
      (function* () {
        for (let offset = 0; offset < bytes.length; offset += 1024) {
          pulled += Math.min(1024, bytes.length - offset);
          yield bytes.subarray(offset, offset + 1024);
        }
      })()
    );
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const reading = readServerDataArchive({
      source,
      openMember: async () => ({
        write: async () => {
          started();
          await gate;
        },
        close: async () => {}
      })
    });
    await entered;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const buffered = pulled;
    release();
    await reading;
    expect(buffered).toBeLessThan(bytes.length / 2);
  });
  it("closes a partially written member on decompression failure", async () => {
    const body = randomBytes(1024 ** 2);
    const bytes = archive([
      member("manifest.json", manifest(1, body.length)),
      member("data/file", body)
    ]);
    let writes = 0,
      closes = 0;
    await expect(
      readServerDataArchive({
        source: Readable.from([bytes.subarray(0, -32768)]),
        openMember: async () => ({
          write: async () => {
            writes++;
          },
          close: async () => {
            closes++;
          }
        })
      })
    ).rejects.toThrow();
    expect(writes).toBeGreaterThan(0);
    expect(closes).toBe(1);
  });
  it("keeps write and close failures together", async () => {
    const writeError = new Error("write"),
      closeError = new Error("close");
    await expect(
      readServerDataArchive({
        source: Readable.from([archive()]),
        openMember: async () => ({
          write: async () => {
            throw writeError;
          },
          close: async () => {
            throw closeError;
          }
        })
      })
    ).rejects.toMatchObject({ errors: [writeError, closeError] });
  });
  it("reports staging cleanup failure without modifying the target", async () => {
    const directory = await root(),
      path = join(directory, "bad.tgz"),
      target = join(directory, "target");
    await writeFile(path, gzipBad);
    await mkdir(target);
    await writeFile(join(target, "keep"), "original");
    cleanupFailure.enabled = true;
    await expect(
      restoreServerDataDirectory({ archivePath: path, dataDirectory: target, overwrite: true })
    ).rejects.toMatchObject({
      diagnostic: { phase: "prepare", outcome: "not_committed", target },
      cause: expect.any(AggregateError)
    });
    expect(await readFile(join(target, "keep"), "utf8")).toBe("original");
    expect(
      (await readdir(target)).some((name) => name.startsWith(".planweave-server-restore-"))
    ).toBe(true);
  });
  it("accepts base-256 tar sizes without buffering member bodies", async () => {
    const header = archiveHeader("data/file", 3);
    header.fill(0, 124, 136);
    header[124] = 0x80;
    header.writeBigUInt64BE(3n, 128);
    updateChecksum(header);
    const bytes = gzipSync(
      tar([
        member("manifest.json", manifest()),
        Buffer.concat([header, Buffer.from("abc"), Buffer.alloc(509)])
      ])
    );
    await expect(readServerDataArchive({ source: Readable.from([bytes]) })).resolves.toMatchObject({
      totalBytes: 3
    });
  });
});
