import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentHostCredentialRenewal } from "../credentials/credentialRenewal.js";
import { FileHostCredentialStore } from "../credentials/fileCredentialStore.js";

const policy = { lifetimeDays: 180, renewal: "automatic" as const };
const active = {
  hostId: "host-http-renewal",
  credentialToken: `pw_host_${"a".repeat(43)}`,
  issuedAt: "2030-01-01T00:00:00.000Z",
  expiresAt: "2030-06-30T00:00:00.000Z",
  credentialPolicy: policy
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(method: "GET" | "POST") {
  const root = await mkdtemp(join(tmpdir(), "pw-renewal-body-"));
  const directory = join(root, "credentials");
  await mkdir(directory, { mode: 0o700 });
  const path = join(directory, "host.json");
  await writeFile(path, JSON.stringify({ version: "agent-host-credentials/v1", active }), {
    mode: 0o600
  });
  const store = new FileHostCredentialStore(path);
  const responses: ServerResponse[] = [];
  const calls: Array<{ method: string; body: string; authorization?: string }> = [];
  let entered!: () => void;
  const received = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let closed = 0;
  let behavior: (response: ServerResponse, body: string) => void = (response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.flushHeaders();
  };
  const status = () => ({
    hostId: active.hostId,
    serverTime: "2030-01-02T00:00:00.000Z",
    credentialExpiresAt: active.expiresAt,
    policy,
    renewalRequestedAt: "2030-01-01T23:59:00.000Z"
  });
  const rotation = (body: string) => ({
    hostId: active.hostId,
    rotationId: JSON.parse(body).rotationId,
    credentialExpiresAt: "2030-07-01T00:00:00.000Z"
  });
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      calls.push({
        method: request.method ?? "",
        body,
        authorization: request.headers.authorization
      });
      if (request.method !== method) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(request.method === "GET" ? status() : rotation(body)));
        return;
      }
      responses.push(response);
      response.on("close", () => {
        closed += 1;
      });
      behavior(response, body);
      entered();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port.");
  let now = new Date("2030-01-02T00:00:00.000Z");
  const renewal = new AgentHostCredentialRenewal(`http://127.0.0.1:${address.port}`, store, {
    clock: () => now
  });
  const results: Promise<unknown>[] = [];
  cleanups.push(async () => {
    for (const response of responses) response.destroy();
    server.closeAllConnections();
    await Promise.allSettled(results);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  function poll(signal?: AbortSignal) {
    const result = renewal.poll(signal);
    results.push(result.catch(() => undefined));
    return result;
  }
  return {
    poll,
    store,
    path,
    received,
    responses,
    calls,
    status,
    rotation,
    closed: () => closed,
    setBehavior: (next: typeof behavior) => {
      behavior = next;
    },
    nextPoll: () => {
      now = new Date(now.getTime() + 30001);
    }
  };
}

async function settledAfterDeadline(result: Promise<unknown>, received: Promise<void>) {
  let settled = false;
  const observed = result.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await received;
  await pause(30);
  await vi.advanceTimersByTimeAsync(30001);
  await pause(50);
  expect(settled).toBe(true);
  await observed;
}

describe("Credential renewal actual HTTP body lifecycle", () => {
  it.each([
    "GET",
    "POST"
  ] as const)("keeps the %s deadline after headers and aborts its body", async (method) => {
    const f = await fixture(method);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const result = f.poll();
    await settledAfterDeadline(result, f.received);
    vi.useRealTimers();
    await vi.waitFor(() => expect(f.closed()).toBe(1));
    expect((await f.store.read())?.active).toEqual(active);
  });

  it.each([
    "GET",
    "POST"
  ] as const)("cancels the actual pending %s body with the owner signal", async (method) => {
    const f = await fixture(method);
    const controller = new AbortController();
    let settled = false;
    const observed = f.poll(controller.signal).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await f.received;
    await pause(30);
    controller.abort();
    await pause(50);
    expect(settled).toBe(true);
    await observed;
    await vi.waitFor(() => expect(f.closed()).toBe(1));
    expect((await f.store.read())?.active).toEqual(active);
  });
  it.each([
    "GET",
    "POST"
  ] as const)("does not extend %s deadline when slow body chunks arrive", async (method) => {
    const f = await fixture(method);
    f.setBehavior((response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write("{");
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const result = f.poll();
    const observed = result.catch(() => undefined);
    await f.received;
    for (let i = 0; i < 3; i++) {
      await pause(10);
      f.responses[0]!.write(" ");
    }
    await settledAfterDeadline(result, f.received);
    vi.useRealTimers();
    await observed;
    await vi.waitFor(() => expect(f.closed()).toBe(1));
    expect(f.responses[0]!.writableEnded).toBe(false);
    expect((await f.store.read())?.active).toEqual(active);
  });

  it.each([
    "GET",
    "POST"
  ] as const)("rejects malformed %s JSON and releases polling for a successful retry", async (method) => {
    const f = await fixture(method);
    f.setBehavior((response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{malformed");
    });
    await expect(f.poll()).rejects.toThrow("agent_host_credential_renewal_response_malformed");
    expect((await f.store.read())?.active).toEqual(active);
    f.nextPoll();
    f.setBehavior((response, body) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(method === "GET" ? f.status() : f.rotation(body)));
    });
    const next = await f.poll();
    expect(next?.hostId).toBe(active.hostId);
    expect(next?.credentialToken).not.toBe(active.credentialToken);
    expect((await f.store.read())?.active).toEqual(next);
    expect((await f.store.read())?.rotation).toBeUndefined();
  });

  it.each([
    ["GET", "declared"],
    ["GET", "streamed"],
    ["POST", "declared"],
    ["POST", "streamed"]
  ] as const)("cancels an oversized %s %s response before body end", async (method, kind) => {
    const f = await fixture(method);
    f.setBehavior((response) => {
      response.writeHead(200, {
        "content-type": "application/json",
        ...(kind === "declared" ? { "content-length": "16385" } : {})
      });
      if (kind === "declared") response.flushHeaders();
      else response.write("x".repeat(16385));
    });
    await expect(f.poll()).rejects.toThrow("agent_host_credential_renewal_response_too_large");
    await vi.waitFor(() => expect(f.closed()).toBe(1));
    expect(f.responses[0]!.writableEnded).toBe(false);
    expect((await f.store.read())?.active).toEqual(active);
  });

  it.each([
    "GET",
    "POST"
  ] as const)("shares one %s poll and immediately retries its canceled authority", async (method) => {
    const f = await fixture(method);
    const controller = new AbortController();
    const before = await readFile(f.path);
    const first = f.poll(controller.signal);
    const second = f.poll(controller.signal);
    expect(second).toBe(first);
    const observed = first.catch(() => undefined);
    await f.received;
    controller.abort();
    await observed;
    expect((await f.store.read())?.active).toEqual(active);
    if (method === "GET") expect(await readFile(f.path)).toEqual(before);
    f.setBehavior((response, body) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(method === "GET" ? f.status() : f.rotation(body)));
    });
    const next = await f.poll();
    expect(next?.credentialToken).not.toBe(active.credentialToken);
    expect((await f.store.read())?.active).toEqual(next);
    const posts = f.calls.filter((call) => call.method === "POST");
    if (method === "POST") expect(posts[1]!.body).toBe(posts[0]!.body);
  });
  it.each([
    "GET",
    "POST"
  ] as const)("cancels a %s request before headers arrive", async (method) => {
    const f = await fixture(method);
    f.setBehavior(() => {});
    const controller = new AbortController();
    const result = f.poll(controller.signal);
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await f.received;
    controller.abort();
    await rejected;
    await vi.waitFor(() => expect(f.closed()).toBe(1));
    expect((await f.store.read())?.active).toEqual(active);
  });

  it("does not commit a stale POST response over a newer persisted credential", async () => {
    const f = await fixture("POST");
    const result = f.poll();
    const rejected = expect(result).rejects.toThrow(
      "agent_host_credential_rotation_response_mismatch"
    );
    await f.received;
    const newer = { ...active, credentialToken: `pw_host_${"b".repeat(43)}` };
    await writeFile(
      f.path,
      JSON.stringify({ version: "agent-host-credentials/v1", active: newer }),
      { mode: 0o600 }
    );
    const bytes = await readFile(f.path);
    f.responses[0]!.end(
      JSON.stringify(f.rotation(f.calls.find((call) => call.method === "POST")!.body))
    );
    await rejected;
    expect(await readFile(f.path)).toEqual(bytes);
    expect((await f.store.read())?.active).toEqual(newer);
  });
});
