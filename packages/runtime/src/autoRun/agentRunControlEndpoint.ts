import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rename, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_RUN_CONTROL_PROTOCOL_VERSION,
  agentRunControlEndpointDescriptorSchema,
  agentRunControlLeaseIdSchema,
  type AgentRunControlEndpointDescriptor,
  type AgentRunControlLeaseId,
  type AgentRunControlTransport
} from "./agentRunControlContract.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const CONTROL_DIRECTORY_NAME = "control";
const CONTROL_DESCRIPTOR_NAME = "endpoint.json";
const UNIX_SOCKET_NAME = "control.sock";

export type AgentRunControlEndpointAllocation = {
  transport: AgentRunControlTransport;
  address: string;
  socketDirectory: string | null;
};

export type AllocateAgentRunControlEndpointOptions = {
  platform?: NodeJS.Platform;
  temporaryRoot?: string;
  randomUUID?: () => string;
};

function errnoCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : null;
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Agent run control directory must be a private real directory.");
  }
  if (process.platform !== "win32" && (metadata.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    throw new Error("Agent run control directory must use owner-only permissions.");
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: PRIVATE_DIRECTORY_MODE });
    if (process.platform !== "win32") await chmod(path, PRIVATE_DIRECTORY_MODE);
  } catch (error) {
    if (errnoCode(error) !== "EEXIST") throw error;
  }
  await assertPrivateDirectory(path);
}

async function assertPrivateDescriptor(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Agent run control descriptor must be a private regular file.");
  }
  if (process.platform !== "win32" && (metadata.mode & 0o777) !== PRIVATE_FILE_MODE) {
    throw new Error("Agent run control descriptor must use owner-only permissions.");
  }
}

export function agentRunControlDescriptorPath(runDir: string): string {
  return join(runDir, CONTROL_DIRECTORY_NAME, CONTROL_DESCRIPTOR_NAME);
}

export async function allocateAgentRunControlEndpoint(
  leaseId: AgentRunControlLeaseId,
  options: AllocateAgentRunControlEndpointOptions = {}
): Promise<AgentRunControlEndpointAllocation> {
  agentRunControlLeaseIdSchema.parse(leaseId);
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const randomUUID = options.randomUUID ?? (() => globalThis.crypto.randomUUID());
    return {
      transport: "named_pipe",
      address: `\\\\.\\pipe\\planweave-${leaseId}-${randomUUID()}`,
      socketDirectory: null
    };
  }

  const directory = await mkdtemp(
    join(options.temporaryRoot ?? tmpdir(), "planweave-acp-control-")
  );
  try {
    await chmod(directory, PRIVATE_DIRECTORY_MODE);
    await assertPrivateDirectory(directory);
    return {
      transport: "unix",
      address: join(directory, UNIX_SOCKET_NAME),
      socketDirectory: directory
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export function createAgentRunControlEndpointDescriptor(options: {
  allocation: AgentRunControlEndpointAllocation;
  leaseId: AgentRunControlLeaseId;
  ownerPid: number;
  publishedAt: string;
}): AgentRunControlEndpointDescriptor {
  return agentRunControlEndpointDescriptorSchema.parse({
    version: AGENT_RUN_CONTROL_PROTOCOL_VERSION,
    transport: options.allocation.transport,
    address: options.allocation.address,
    leaseId: options.leaseId,
    ownerPid: options.ownerPid,
    publishedAt: options.publishedAt
  });
}

export async function publishAgentRunControlDescriptor(
  runDir: string,
  rawDescriptor: AgentRunControlEndpointDescriptor
): Promise<string> {
  const descriptor = agentRunControlEndpointDescriptorSchema.parse(rawDescriptor);
  const directory = join(runDir, CONTROL_DIRECTORY_NAME);
  await ensurePrivateDirectory(directory);
  const descriptorPath = agentRunControlDescriptorPath(runDir);
  const temporaryPath = join(
    directory,
    `.endpoint.${process.pid}.${globalThis.crypto.randomUUID()}.tmp`
  );
  const handle = await open(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    PRIVATE_FILE_MODE
  );
  try {
    await handle.writeFile(`${JSON.stringify(descriptor, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await rename(temporaryPath, descriptorPath);
    if (process.platform !== "win32") await chmod(descriptorPath, PRIVATE_FILE_MODE);
    await assertPrivateDescriptor(descriptorPath);
    return descriptorPath;
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function readAgentRunControlDescriptor(
  runDir: string
): Promise<AgentRunControlEndpointDescriptor | null> {
  const descriptorPath = agentRunControlDescriptorPath(runDir);
  try {
    await assertPrivateDirectory(join(runDir, CONTROL_DIRECTORY_NAME));
    await assertPrivateDescriptor(descriptorPath);
    return agentRunControlEndpointDescriptorSchema.parse(
      JSON.parse(await readFile(descriptorPath, "utf8")) as unknown
    );
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
}

export async function revokeAgentRunControlDescriptor(
  runDir: string,
  leaseId: AgentRunControlLeaseId
): Promise<boolean> {
  agentRunControlLeaseIdSchema.parse(leaseId);
  const descriptor = await readAgentRunControlDescriptor(runDir);
  if (descriptor === null || descriptor.leaseId !== leaseId) return false;
  try {
    await unlink(agentRunControlDescriptorPath(runDir));
    return true;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return false;
    throw error;
  }
}

export async function releaseAgentRunControlEndpoint(
  allocation: AgentRunControlEndpointAllocation
): Promise<void> {
  if (allocation.socketDirectory === null) return;
  await rm(allocation.socketDirectory, { recursive: true, force: true });
}
