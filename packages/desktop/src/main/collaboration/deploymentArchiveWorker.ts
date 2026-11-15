import { constants, lstatSync, realpathSync, type BigIntStats } from "node:fs";
import { open, opendir } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { parentPort, workerData, type MessagePort } from "node:worker_threads";
import { zipSync } from "fflate";
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

async function readArchiveFile(
  path: string,
  metadata: BigIntStats,
  directory: DirectorySnapshot,
  total: ArchiveBudget
): Promise<Uint8Array> {
  if (
    !metadata.isFile() ||
    total.entries >= maxZipEntries ||
    metadata.size > BigInt(maxBundleInputBytes - total.bytes)
  ) {
    throw new InvalidArchiveInput();
  }
  verifyDirectory(directory);
  await using file = await open(path, readFlags);
  const opened = await file.stat({ bigint: true });
  if (!matchesFile(opened, metadata)) throw new InvalidArchiveInput();
  verifyFilePath(path, opened, directory);

  const bytes = new Uint8Array(Number(opened.size));
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesRead } = await file.read(bytes, offset, bytes.byteLength - offset, offset);
    if (bytesRead === 0) throw new InvalidArchiveInput();
    offset += bytesRead;
  }
  const { bytesRead: extraBytes } = await file.read(new Uint8Array(1), 0, 1, offset);
  if (extraBytes !== 0 || !matchesFile(await file.stat({ bigint: true }), opened)) {
    throw new InvalidArchiveInput();
  }
  verifyFilePath(path, opened, directory);
  total.bytes += offset;
  total.entries += 1;
  return bytes;
}

async function archiveDirectory(
  directory: DirectorySnapshot,
  prefix: string,
  output: Record<string, Uint8Array>,
  total: ArchiveBudget
): Promise<void> {
  verifyDirectory(directory);
  const entries = await opendir(directory.path);
  for await (const { name: entry } of entries) {
    verifyDirectory(directory);
    const path = resolve(directory.path, entry);
    if (relative(directory.path, path).startsWith("..") || entry.includes("\\")) {
      throw new InvalidArchiveInput();
    }
    const metadata = lstatSync(path, { bigint: true });
    const name = `${prefix}/${entry}`;
    if (metadata.isDirectory()) {
      await archiveDirectory({ path, metadata, parent: directory }, name, output, total);
    } else {
      output[name] = await readArchiveFile(path, metadata, directory, total);
    }
  }
  verifyDirectory(directory);
}

async function createArchive(input: DeploymentArchiveInput): Promise<ArrayBuffer> {
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
  files["compose.yaml"] = await readArchiveFile(
    compose,
    lstatSync(compose, { bigint: true }),
    root,
    total
  );
  const image = resolve(root.path, "image");
  await archiveDirectory(
    { path: image, metadata: lstatSync(image, { bigint: true }), parent: root },
    "image",
    files,
    total
  );
  verifyResourcePath(input.resourceDirectory, root);
  const archive = zipSync(files, { level: 6 });
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

async function sendArchive(port: MessagePort, data: unknown): Promise<void> {
  let response: DeploymentArchiveReply;
  try {
    const input = deploymentArchiveInputSchema.parse(data);
    response = { state: "ready", bytes: await createArchive(input) };
  } catch (error) {
    response = { state: isInvalidArchiveInput(error) ? "invalid_project" : "failed" };
  }
  port.postMessage(response, response.state === "ready" ? [response.bytes] : []);
  port.close();
}

if (!parentPort) throw new Error("deployment_archive_worker_requires_parent");
void sendArchive(parentPort, workerData);
