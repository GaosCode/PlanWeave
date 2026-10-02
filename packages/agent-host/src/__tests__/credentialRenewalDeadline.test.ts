import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentHostCredentialRenewal } from "../credentials/credentialRenewal.js";
import { FileHostCredentialStore } from "../credentials/fileCredentialStore.js";

const directories: string[] = [];
const active = {
  hostId: "host-deadline",
  credentialToken: `pw_host_${"a".repeat(43)}`,
  issuedAt: "2030-01-01T00:00:00.000Z",
  expiresAt: "2030-06-30T00:00:00.000Z",
  credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
};
const status = {
  hostId: active.hostId,
  serverTime: "2030-01-02T00:00:00.000Z",
  credentialExpiresAt: active.expiresAt,
  policy: active.credentialPolicy
};

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function fixture(request: typeof fetch) {
  const root = await mkdtemp(join(tmpdir(), "pw-renewal-deadline-"));
  directories.push(root);
  const directory = join(root, "credentials");
  await mkdir(directory, { mode: 0o700 });
  const path = join(directory, "host.json");
  await writeFile(path, JSON.stringify({ version: "agent-host-credentials/v1", active }), {
    mode: 0o600
  });
  const store = new FileHostCredentialStore(path);
  let now = new Date(status.serverTime);
  const renewal = new AgentHostCredentialRenewal("https://server.example", store, {
    request,
    clock: () => now
  });
  return {
    store,
    renewal,
    nextPoll: () => {
      now = new Date(now.getTime() + 30001);
    }
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function jsonResponse(payload: unknown, code = 200) {
  return new Response(JSON.stringify(payload), {
    status: code,
    headers: { "content-type": "application/json" }
  });
}

describe("Credential renewal owner deadline and cleanup", () => {
  it("checks the absolute deadline between immediate chunks even before the timer runs", async () => {
    let elapsed = 0;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        elapsed += 11000;
        controller.enqueue(new Uint8Array(0));
      },
      cancel
    });
    const f = await fixture(
      async () =>
        new Response(body, {
          headers: { "content-type": "application/json" }
        })
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    await expect(f.renewal.poll()).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    "headers",
    "body",
    "slow body"
  ])("settles a non-cooperating %s request at one deadline and permits retry", async (stage) => {
    const entered = deferred<void>();
    const headers = deferred<Response>();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
      cancel
    });
    const response = new Response(body, { headers: { "content-type": "application/json" } });
    let requestSignal: AbortSignal | undefined;
    let retry = false;
    const f = await fixture(async (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      entered.resolve();
      return retry ? jsonResponse(status) : stage === "headers" ? headers.promise : response;
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let error: unknown;
    let settled = false;
    const operation = f.renewal
      .poll()
      .catch((failure: unknown) => {
        error = failure;
      })
      .finally(() => {
        settled = true;
      });
    await entered.promise;
    if (stage === "slow body") {
      for (let i = 0; i < 3; i++) {
        streamController.enqueue(new TextEncoder().encode(" "));
        await vi.advanceTimersByTimeAsync(9000);
      }
    }
    await vi.advanceTimersByTimeAsync(stage === "slow body" ? 3001 : 30001);
    // Settle the source so a failed deadline assertion leaves no pending read.
    const settledAtDeadline = settled;
    if (!settled) {
      if (stage === "headers") headers.resolve(jsonResponse(status));
      else streamController.close();
    } else if (stage === "headers") {
      headers.resolve(response);
    }
    await operation;
    await Promise.resolve();
    expect(settledAtDeadline).toBe(true);
    expect(error).toMatchObject({ name: "AbortError" });
    expect(requestSignal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
    expect((await f.store.read())?.active).toEqual(active);
    expect(vi.getTimerCount()).toBe(0);
    retry = true;
    f.nextPoll();
    await expect(f.renewal.poll()).resolves.toBeUndefined();
  });

  it.each([
    ["type", { "content-type": "text/plain" }, "malformed"],
    ["length", { "content-type": "application/json", "content-length": "invalid" }, "malformed"],
    [
      "declared limit",
      { "content-type": "application/json", "content-length": "16385" },
      "too_large"
    ],
    ["chunk limit", { "content-type": "application/json" }, "too_large"],
    ["cancel rejection", { "content-type": "text/plain" }, "malformed"]
  ] as const)("preserves %s failure despite a non-cooperating cancel and releases the stream", async (kind, responseHeaders, reason) => {
    const cancel = vi.fn(() =>
      kind === "cancel rejection"
        ? Promise.reject(new Error("cleanup failed"))
        : new Promise<void>(() => {})
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (kind === "chunk limit") controller.enqueue(new Uint8Array(16385));
      },
      cancel
    });
    const f = await fixture(async () => new Response(body, { headers: responseHeaders }));
    // The owner must not wait for an underlying source's cancellation promise.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let outcome: unknown;
    try {
      outcome = await Promise.race([
        f.renewal.poll().then(
          () => "resolved",
          (error: unknown) => error
        ),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve("pending"), 100);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
    expect(outcome).toMatchObject({ message: `agent_host_credential_renewal_response_${reason}` });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
    expect((await f.store.read())?.active).toEqual(active);
  });

  it.each([
    "JSON",
    "schema",
    "rejected",
    "reader"
  ])("retains %s errors and leaves credentials unchanged", async (kind) => {
    const failure = new Error("reader failed");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(failure);
      }
    });
    const response =
      kind === "reader"
        ? new Response(body, { headers: { "content-type": "application/json" } })
        : kind === "JSON"
          ? new Response("{", { headers: { "content-type": "application/json" } })
          : jsonResponse(
              kind === "rejected" ? { error: "credential_rejected" } : {},
              kind === "rejected" ? 401 : 200
            );
    const f = await fixture(async () => response);
    await expect(f.renewal.poll()).rejects.toThrow(
      kind === "reader"
        ? "reader failed"
        : kind === "JSON"
          ? "response_malformed"
          : kind === "rejected"
            ? "renewal_rejected:credential_rejected"
            : undefined
    );
    expect(response.body?.locked).toBe(false);
    expect((await f.store.read())?.active).toEqual(active);
  });
});
