import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createWorkspaceJsonTransport } from "../workspaceExecution/httpTransport.js";
import { WorkspaceExecutionHttpHarness } from "./support/workspaceExecutionHttpHarness.js";

const schema = z.object({ ok: z.boolean() });
const timeoutError = {
  code: "workspace_http_unavailable",
  exitCode: 9,
  retryable: true,
  failureKind: "unavailable"
};

function transport(request: typeof fetch, timeoutMs = 100) {
  return createWorkspaceJsonTransport({
    serverOrigin: "http://127.0.0.1",
    credential: "test-credential",
    fetch: request,
    timeoutMs
  });
}

function bodyStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    cancel
  });
  return { body, controller, cancel };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("workspace HTTP response lifecycle", () => {
  it("bounds a real HTTP response that sends headers then hangs its body", async () => {
    const server = new WorkspaceExecutionHttpHarness({
      sourceRevision: "test",
      graphFingerprint: "test",
      dispatchMode: "completed",
      registryCanvases: [],
      hangingBody: { status: 200 }
    });
    const origin = await server.start();
    const client = createWorkspaceJsonTransport({
      serverOrigin: origin,
      credential: "test",
      timeoutMs: 100
    });
    let guard: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        client.json("POST", "/hanging-body", schema).catch((error: unknown) => error),
        new Promise<string>((resolve) => {
          guard = setTimeout(() => resolve("body_deadline_missing"), 500);
        })
      ]);
      clearTimeout(guard);
      expect(result).toMatchObject(timeoutError);
      expect(server.calls).toEqual(["POST /hanging-body"]);
      const closed = await Promise.race([
        server.hangingBodyClosed.then(() => true),
        new Promise<boolean>((resolve) => {
          guard = setTimeout(() => resolve(false), 500);
        })
      ]);
      expect(closed).toBe(true);
    } finally {
      clearTimeout(guard);
      await server.stop();
    }
  });
  it.each([
    "json",
    "error-json",
    "bytes"
  ] as const)("keeps the total deadline through a hanging %s body and cancels it", async (kind) => {
    vi.useFakeTimers();
    const stream = bodyStream();
    const request = vi.fn<typeof fetch>(
      async () => new Response(stream.body, { status: kind === "error-json" ? 403 : 200 })
    );
    const client = transport(request);
    const result = (
      kind === "bytes" ? client.bytes("POST", "/test") : client.json("POST", "/test", schema)
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(40);
    stream.controller.enqueue(new TextEncoder().encode("{"));
    await vi.advanceTimersByTimeAsync(40);
    stream.controller.enqueue(new TextEncoder().encode(" "));
    await vi.advanceTimersByTimeAsync(20);
    expect(await result).toMatchObject(timeoutError);
    expect(stream.cancel).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    "json",
    "error-json",
    "bytes"
  ] as const)("preserves caller cancellation after headers during %s body consumption", async (kind) => {
    vi.useFakeTimers();
    const stream = bodyStream();
    const abort = new AbortController();
    const reason = new Error("caller stopped");
    let requestSignal: AbortSignal | null | undefined;
    const client = transport(async (_url, init) => {
      requestSignal = init?.signal;
      return new Response(stream.body, { status: kind === "error-json" ? 409 : 200 });
    });
    const remove = vi.spyOn(abort.signal, "removeEventListener");
    const result = (
      kind === "bytes"
        ? client.bytes("GET", "/test", { signal: abort.signal })
        : client.json("GET", "/test", schema, { signal: abort.signal })
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(20);
    stream.controller.enqueue(new TextEncoder().encode("{"));
    await vi.advanceTimersByTimeAsync(20);
    abort.abort(reason);
    expect(await result).toBe(reason);
    expect(requestSignal?.reason).toBe(reason);
    expect(stream.cancel).toHaveBeenCalledWith(reason);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    "before-headers",
    "initial"
  ] as const)("cancels %s without waiting for a noncooperative fetch", async (phase) => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const reason = new DOMException("caller cancelled", "AbortError");
    const request = vi.fn<typeof fetch>(async () => new Promise<Response>(() => undefined));
    if (phase === "initial") abort.abort(reason);
    const result = transport(request)
      .json("GET", "/test", schema, { signal: abort.signal })
      .catch((error: unknown) => error);
    if (phase === "before-headers") abort.abort(reason);
    expect(await result).toBe(reason);
    expect(request).toHaveBeenCalledTimes(phase === "initial" ? 0 : 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    "caller",
    "timeout"
  ] as const)("preserves the first cancellation when %s wins at the deadline", async (first) => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const reason = new Error("caller won");
    if (first === "caller") setTimeout(() => abort.abort(reason), 100);
    const result = transport(async () => new Promise<Response>(() => undefined))
      .json("GET", "/test", schema, { signal: abort.signal })
      .catch((error: unknown) => error);
    if (first === "timeout") setTimeout(() => abort.abort(reason), 100);
    await vi.advanceTimersByTimeAsync(100);
    if (first === "caller") expect(await result).toBe(reason);
    else expect(await result).toMatchObject(timeoutError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns JSON and binary headers unchanged and releases successful request listeners", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const remove = vi.spyOn(abort.signal, "removeEventListener");
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-credential");
      return init?.method === "POST"
        ? Response.json({ ok: true })
        : new Response(new Uint8Array([1, 2]), { headers: { "x-result": "preserved" } });
    });
    const client = transport(request);
    expect(
      await client.json("POST", "/test", schema, { body: { data: true }, signal: abort.signal })
    ).toEqual({ ok: true });
    const bytes = await client.bytes("GET", "/test", { maxBytes: 2, signal: abort.signal });
    expect(bytes.body).toEqual(new Uint8Array([1, 2]));
    expect(bytes.headers.get("x-result")).toBe("preserved");
    expect(remove).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    abort.abort();
    await vi.advanceTimersByTimeAsync(200);
  });

  it.each([
    [
      "malformed JSON",
      () => new Response("{"),
      "workspace_http_invalid_response",
      9,
      true,
      undefined
    ],
    [
      "invalid schema",
      () => Response.json({ ok: "yes" }),
      "workspace_http_invalid_response",
      9,
      true,
      undefined
    ],
    [
      "empty HTTP error",
      () => new Response(null, { status: 401 }),
      "workspace_http_unauthorized",
      4,
      false,
      "authentication"
    ],
    [
      "domain error",
      () => Response.json({ error: "remote_interaction_expired" }, { status: 409 }),
      "remote_interaction_expired",
      7,
      false,
      "conflict"
    ],
    [
      "network failure",
      () => {
        throw new Error("network failed");
      },
      "workspace_http_unavailable",
      9,
      true,
      "unavailable"
    ]
  ] as const)("retains classification and cleanup for %s", async (_name, response, code, exitCode, retryable, failureKind) => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const remove = vi.spyOn(abort.signal, "removeEventListener");
    const result = await transport(async () => response())
      .json("GET", "/test", schema, { signal: abort.signal })
      .catch((error: unknown) => error);
    expect(result).toMatchObject({ code, exitCode, retryable });
    expect(result).toMatchObject({ failureKind });
    expect(remove).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops slow binary consumption at maxBytes despite an inaccurate Content-Length", async () => {
    vi.useFakeTimers();
    const stream = bodyStream();
    const result = transport(
      async () => new Response(stream.body, { headers: { "content-length": "1" } })
    )
      .bytes("GET", "/test", { maxBytes: 2 })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10);
    stream.controller.enqueue(new Uint8Array([1, 2]));
    await vi.advanceTimersByTimeAsync(10);
    stream.controller.enqueue(new Uint8Array([3]));
    expect(await result).toMatchObject({
      code: "workspace_http_invalid_response",
      exitCode: 9,
      retryable: true
    });
    expect(stream.cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    "resolve",
    "reject"
  ] as const)("observes late fetch %s after timeout and cancels a late response", async (settlement) => {
    vi.useFakeTimers();
    let resolve!: (response: Response) => void;
    let reject!: (error: Error) => void;
    const stream = bodyStream();
    const result = transport(
      async () =>
        new Promise<Response>((yes, no) => {
          resolve = yes;
          reject = no;
        })
    )
      .json("GET", "/test", schema)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toMatchObject(timeoutError);
    if (settlement === "resolve") resolve(new Response(stream.body));
    else reject(new Error("late network failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(stream.cancel).toHaveBeenCalledTimes(settlement === "resolve" ? 1 : 0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("observes a rejecting body cancellation after caller abort", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const reason = new Error("stop");
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        return Promise.reject(new Error("late cleanup failure"));
      }
    });
    const result = transport(async () => new Response(body))
      .json("GET", "/test", schema, { signal: abort.signal })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10);
    abort.abort(reason);
    expect(await result).toBe(reason);
    await vi.advanceTimersByTimeAsync(0);
    expect(body.locked).toBe(false);
  });

  it("closes a real HTTP body connection when the caller cancels after headers", async () => {
    const server = new WorkspaceExecutionHttpHarness({
      sourceRevision: "test",
      graphFingerprint: "test",
      dispatchMode: "completed",
      registryCanvases: [],
      hangingBody: { status: 403 }
    });
    const origin = await server.start();
    const abort = new AbortController();
    const reason = new DOMException("caller cancelled", "AbortError");
    let receivedHeaders!: () => void;
    const headersReceived = new Promise<void>((resolve) => {
      receivedHeaders = resolve;
    });
    const client = createWorkspaceJsonTransport({
      serverOrigin: origin,
      credential: "test",
      timeoutMs: 1000,
      fetch: async (url, init) => {
        const response = await fetch(url, init);
        receivedHeaders();
        return response;
      }
    });
    let guard: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = client
        .json("GET", "/hanging-body", schema, { signal: abort.signal })
        .catch((error: unknown) => error);
      await server.hangingBodyStarted;
      await Promise.race([
        headersReceived,
        result.then(() => {
          throw new Error("request settled before headers were received");
        })
      ]);
      abort.abort(reason);
      expect(await result).toBe(reason);
      const closed = await Promise.race([
        server.hangingBodyClosed.then(() => true),
        new Promise<boolean>((resolve) => {
          guard = setTimeout(() => resolve(false), 500);
        })
      ]);
      expect(closed).toBe(true);
    } finally {
      clearTimeout(guard);
      await server.stop();
    }
  });

  it("rejects a synchronous schema conversion that finishes after the deadline", async () => {
    const clock = vi.spyOn(performance, "now");
    clock.mockReturnValueOnce(0).mockReturnValue(101);
    const result = await transport(async () => Response.json({ ok: true }))
      .json("GET", "/test", {
        safeParse(value) {
          return { success: true as const, data: value };
        }
      })
      .catch((error: unknown) => error);
    expect(result).toMatchObject(timeoutError);
  });
  it.each([
    "json",
    "bytes",
    "error-json"
  ] as const)("classifies a failed %s body without leaving its stream locked", async (kind) => {
    vi.useFakeTimers();
    const stream = bodyStream();
    const client = transport(
      async () => new Response(stream.body, { status: kind === "error-json" ? 403 : 200 })
    );
    const result = (
      kind === "bytes" ? client.bytes("GET", "/test") : client.json("GET", "/test", schema)
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10);
    stream.controller.error(new Error("connection closed during body"));
    expect(await result).toMatchObject(
      kind === "error-json"
        ? {
            code: "workspace_http_forbidden",
            exitCode: 5,
            retryable: false,
            failureKind: "authorization"
          }
        : { code: "workspace_http_invalid_response", exitCode: 9, retryable: true }
    );
    expect(stream.body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns all streamed bytes when the caller supplies no size limit", async () => {
    vi.useFakeTimers();
    const stream = bodyStream();
    const result = transport(async () => new Response(stream.body)).bytes("GET", "/test");
    await vi.advanceTimersByTimeAsync(10);
    stream.controller.enqueue(new Uint8Array([1, 2]));
    await vi.advanceTimersByTimeAsync(10);
    stream.controller.enqueue(new Uint8Array([3, 4]));
    stream.controller.close();
    expect((await result).body).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(stream.cancel).not.toHaveBeenCalled();
    expect(stream.body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([
    "initial",
    "after-headers"
  ] as const)("retains the existing null abort reason convention %s", async (phase) => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const stream = bodyStream();
    if (phase === "initial") abort.abort(null);
    const result = transport(async () => new Response(stream.body))
      .json("GET", "/test", schema, { signal: abort.signal })
      .catch((error: unknown) => error);
    if (phase === "after-headers") {
      await vi.advanceTimersByTimeAsync(10);
      abort.abort(null);
    }
    expect(await result).toBeInstanceOf(DOMException);
    expect(await result).toMatchObject({ name: "AbortError" });
    if (phase === "after-headers") expect(stream.cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
