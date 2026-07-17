import { chmod, lstat, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentRunControlLeaseIdSchema } from "../autoRun/agentRunControlContract.js";
import {
  agentRunControlDescriptorPath,
  allocateAgentRunControlEndpoint,
  createAgentRunControlEndpointDescriptor,
  publishAgentRunControlDescriptor,
  readAgentRunControlDescriptor,
  releaseAgentRunControlEndpoint,
  revokeAgentRunControlDescriptor
} from "../autoRun/agentRunControlEndpoint.js";

const roots: string[] = [];
const firstLease = agentRunControlLeaseIdSchema.parse("3e230493-760f-4e93-86b3-46e95eb1f10a");
const secondLease = agentRunControlLeaseIdSchema.parse("9d71cf62-7c7c-4cdc-8b19-f990cf180d99");

async function temporaryRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `planweave-control-${label}-`));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("agent run control endpoint", () => {
  it("publishes and revokes a strict private descriptor atomically", async () => {
    const runDir = await temporaryRoot("descriptor");
    const allocation = await allocateAgentRunControlEndpoint(firstLease, {
      platform: "linux",
      temporaryRoot: tmpdir()
    });
    const descriptor = createAgentRunControlEndpointDescriptor({
      allocation,
      leaseId: firstLease,
      ownerPid: 4242,
      publishedAt: "2026-07-17T07:00:00.000Z"
    });

    const descriptorPath = await publishAgentRunControlDescriptor(runDir, descriptor);
    expect(descriptorPath).toBe(agentRunControlDescriptorPath(runDir));
    expect(await readAgentRunControlDescriptor(runDir)).toEqual(descriptor);
    if (process.platform !== "win32") {
      expect((await lstat(join(runDir, "control"))).mode & 0o777).toBe(0o700);
      expect((await lstat(descriptorPath)).mode & 0o777).toBe(0o600);
      expect((await lstat(allocation.socketDirectory ?? "")).mode & 0o777).toBe(0o700);
    }

    expect(await revokeAgentRunControlDescriptor(runDir, firstLease)).toBe(true);
    expect(await readAgentRunControlDescriptor(runDir)).toBeNull();
    expect(await revokeAgentRunControlDescriptor(runDir, firstLease)).toBe(false);
    await releaseAgentRunControlEndpoint(allocation);
  });

  it("does not let an old lease revoke a replacement descriptor", async () => {
    const runDir = await temporaryRoot("rotation");
    const allocation = {
      transport: "unix" as const,
      address: "/tmp/planweave-control.sock",
      socketDirectory: null
    };
    const first = createAgentRunControlEndpointDescriptor({
      allocation,
      leaseId: firstLease,
      ownerPid: 100,
      publishedAt: "2026-07-17T07:00:00.000Z"
    });
    const replacement = createAgentRunControlEndpointDescriptor({
      allocation,
      leaseId: secondLease,
      ownerPid: 200,
      publishedAt: "2026-07-17T07:01:00.000Z"
    });

    await publishAgentRunControlDescriptor(runDir, first);
    await publishAgentRunControlDescriptor(runDir, replacement);
    expect(await revokeAgentRunControlDescriptor(runDir, firstLease)).toBe(false);
    expect(await readAgentRunControlDescriptor(runDir)).toEqual(replacement);
    expect(await revokeAgentRunControlDescriptor(runDir, secondLease)).toBe(true);
  });

  it("creates an unguessable bounded Windows named pipe address", async () => {
    const allocation = await allocateAgentRunControlEndpoint(firstLease, {
      platform: "win32",
      randomUUID: () => "5f546816-f450-4fb1-8173-10bb3c9bfdee"
    });

    expect(allocation).toEqual({
      transport: "named_pipe",
      address:
        "\\\\.\\pipe\\planweave-3e230493-760f-4e93-86b3-46e95eb1f10a-5f546816-f450-4fb1-8173-10bb3c9bfdee",
      socketDirectory: null
    });
    expect(() =>
      createAgentRunControlEndpointDescriptor({
        allocation,
        leaseId: firstLease,
        ownerPid: 4242,
        publishedAt: "2026-07-17T07:00:00.000Z"
      })
    ).not.toThrow();
  });

  it.runIf(process.platform !== "win32")(
    "rejects a symbolic-link control directory instead of publishing outside the run",
    async () => {
      const runDir = await temporaryRoot("symlink-run");
      const outside = await temporaryRoot("symlink-outside");
      await chmod(outside, 0o700);
      await symlink(outside, join(runDir, "control"));
      const descriptor = createAgentRunControlEndpointDescriptor({
        allocation: {
          transport: "unix",
          address: "/tmp/planweave-control.sock",
          socketDirectory: null
        },
        leaseId: firstLease,
        ownerPid: 4242,
        publishedAt: "2026-07-17T07:00:00.000Z"
      });

      await expect(publishAgentRunControlDescriptor(runDir, descriptor)).rejects.toThrow(
        "private real directory"
      );
    }
  );
});
