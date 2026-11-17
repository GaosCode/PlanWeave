import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { parentPort, workerData, type MessagePort } from "node:worker_threads";
import { deflateSync, type Zippable, zipSync } from "fflate";
import {
  deploymentArchiveInputSchema,
  type DeploymentArchiveInput,
  type DeploymentArchiveReply
} from "./deploymentArchiveMessages.js";

const maxBundleInputBytes = 256 * 1024 * 1024;
const maxZipEntries = 0xffff;
const readFlags =
  process.platform === "win32"
    ? constants.O_RDONLY
    : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

class InvalidArchiveInput extends Error {}

type DirectorySnapshot = {
  path: string;
  metadata: BigIntStats;
  parent?: DirectorySnapshot;
};

type ArchiveBudget = { bytes: number; entries: number };

function sameMetadata(current: BigIntStats, expected: BigIntStats): boolean {
  return (
    current.dev === expected.dev &&
    current.ino === expected.ino &&
    current.ctimeNs === expected.ctimeNs &&
    current.mtimeNs === expected.mtimeNs
  );
}

function verifyDirectory(directory: DirectorySnapshot): void {
  if (realpathSync.native(directory.path) !== directory.path) throw new InvalidArchiveInput();
  for (
    let ancestor: DirectorySnapshot | undefined = directory;
    ancestor;
    ancestor = ancestor.parent
  ) {
    const current = lstatSync(ancestor.path, { bigint: true });
    if (!current.isDirectory() || !sameMetadata(current, ancestor.metadata)) {
      throw new InvalidArchiveInput();
    }
  }
}

function verifyResourcePath(path: string, root: DirectorySnapshot): void {
  if (path !== root.path) {
    if (realpathSync.native(path) !== root.path) throw new InvalidArchiveInput();
    const current = lstatSync(path, { bigint: true });
    if (!current.isDirectory() || !sameMetadata(current, root.metadata)) {
      throw new InvalidArchiveInput();
    }
  }
  verifyDirectory(root);
}

function matchesFile(current: BigIntStats, expected: BigIntStats): boolean {
  return current.isFile() && current.size === expected.size && sameMetadata(current, expected);
}

function verifyFilePath(path: string, metadata: BigIntStats, directory: DirectorySnapshot): void {
  const current = lstatSync(path, { bigint: true });
  if (!matchesFile(current, metadata)) throw new InvalidArchiveInput();
  verifyDirectory(directory);
}

function readArchiveFile(
  path: string,
  metadata: BigIntStats,
  directory: DirectorySnapshot,
  total: ArchiveBudget
): Uint8Array {
  if (
    !metadata.isFile() ||
    total.entries >= maxZipEntries ||
    metadata.size > BigInt(maxBundleInputBytes - total.bytes)
  ) {
    throw new InvalidArchiveInput();
  }
  verifyDirectory(directory);
  const file = openSync(path, readFlags);
  try {
    const opened = fstatSync(file, { bigint: true });
    if (!matchesFile(opened, metadata)) throw new InvalidArchiveInput();
    verifyFilePath(path, opened, directory);

    const bytes = new Uint8Array(Number(opened.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const bytesRead = readSync(file, bytes, offset, bytes.byteLength - offset, offset);
      if (bytesRead === 0) throw new InvalidArchiveInput();
      offset += bytesRead;
    }
    const extraBytes = readSync(file, new Uint8Array(1), 0, 1, offset);
    if (extraBytes !== 0 || !matchesFile(fstatSync(file, { bigint: true }), opened)) {
      throw new InvalidArchiveInput();
    }
    verifyFilePath(path, opened, directory);
    total.bytes += offset;
    total.entries += 1;
    return bytes;
  } finally {
    closeSync(file);
  }
}

function archiveDirectory(
  directory: DirectorySnapshot,
  prefix: string,
  output: Record<string, Uint8Array>,
  total: ArchiveBudget
): void {
  verifyDirectory(directory);
  const entries = opendirSync(directory.path);
  try {
    for (let entry = entries.readSync(); entry; entry = entries.readSync()) {
      verifyDirectory(directory);
      const path = resolve(directory.path, entry.name);
      if (relative(directory.path, path).startsWith("..") || entry.name.includes("\\")) {
        throw new InvalidArchiveInput();
      }
      const metadata = lstatSync(path, { bigint: true });
      const name = `${prefix}/${entry.name}`;
      if (metadata.isDirectory()) {
        archiveDirectory({ path, metadata, parent: directory }, name, output, total);
      } else {
        output[name] = readArchiveFile(path, metadata, directory, total);
      }
    }
  } finally {
    entries.closeSync();
  }
  verifyDirectory(directory);
}

function shouldStoreArchiveEntry(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 2 * 1024 * 1024) return false;

  const sampleSize = 16 * 1024;
  const sampleCount = 17;
  const lastSampleOffset = bytes.byteLength - sampleSize;
  for (let index = 0; index < sampleCount; index++) {
    const offset = Math.floor((lastSampleOffset * index) / (sampleCount - 1));
    const sample = bytes.subarray(offset, offset + sampleSize);
    if (deflateSync(sample, { level: 1 }).byteLength < sampleSize * 0.99) return false;
  }
  return true;
}

function createArchive(input: DeploymentArchiveInput): ArrayBuffer {
  if (!isAbsolute(input.resourceDirectory)) throw new InvalidArchiveInput();
  const metadata = lstatSync(input.resourceDirectory, { bigint: true });
  if (!metadata.isDirectory()) throw new InvalidArchiveInput();
  const root = { path: realpathSync.native(input.resourceDirectory), metadata };
  verifyResourcePath(input.resourceDirectory, root);
  const encode = new TextEncoder();
  const files: Record<string, Uint8Array> = {
    "server.json": encode.encode(input.serverJson),
    ".operator-token": encode.encode(input.operatorTokenFile),
    "write-desktop-connection.sh": encode.encode(input.connectionScript),
    "restore-server-data.sh": encode.encode(input.restoreScript),
    "tls/.gitkeep": new Uint8Array()
  };
  const total: ArchiveBudget = {
    bytes: Object.values(files).reduce((sum, file) => sum + file.byteLength, 0),
    entries: Object.keys(files).length
  };
  if (total.bytes > maxBundleInputBytes) throw new InvalidArchiveInput();
  const compose = resolve(root.path, "compose.yaml");
  files["compose.yaml"] = readArchiveFile(
    compose,
    lstatSync(compose, { bigint: true }),
    root,
    total
  );
  const image = resolve(root.path, "image");
  archiveDirectory(
    { path: image, metadata: lstatSync(image, { bigint: true }), parent: root },
    "image",
    files,
    total
  );
  verifyResourcePath(input.resourceDirectory, root);
  const zipEntries: Zippable = {};
  for (const [name, bytes] of Object.entries(files)) {
    zipEntries[name] = shouldStoreArchiveEntry(bytes) ? [bytes, { level: 0 }] : bytes;
  }
  const archive = zipSync(zipEntries, { level: 6 });
  if (
    !(archive.buffer instanceof ArrayBuffer) ||
    archive.byteOffset !== 0 ||
    archive.byteLength !== archive.buffer.byteLength
  ) {
    throw new Error("deployment_archive_invalid_buffer");
  }
  return archive.buffer;
}

const invalidArchiveSourceCodes = new Set(["ENOENT", "ENOTDIR", "ELOOP", "ENAMETOOLONG", "ESTALE"]);

function isInvalidArchiveInput(error: unknown): boolean {
  return (
    error instanceof InvalidArchiveInput ||
    (error instanceof Error &&
      "code" in error &&
      typeof error.code === "string" &&
      invalidArchiveSourceCodes.has(error.code))
  );
}

function sendArchive(port: MessagePort, data: unknown): void {
  let response: DeploymentArchiveReply;
  try {
    const input = deploymentArchiveInputSchema.parse(data);
    response = { state: "ready", bytes: createArchive(input) };
  } catch (error) {
    response = { state: isInvalidArchiveInput(error) ? "invalid_project" : "failed" };
  }
  port.postMessage(response, response.state === "ready" ? [response.bytes] : []);
  port.close();
}

if (!parentPort) throw new Error("deployment_archive_worker_requires_parent");
sendArchive(parentPort, workerData);
