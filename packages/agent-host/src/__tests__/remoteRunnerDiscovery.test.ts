import { describe, expect, it, vi } from "vitest";
import {
  discoverRemoteRunnerEventProtocol,
  parseRemoteRunnerRetryAfter,
  RemoteRunnerDiscoveryError
} from "../transport/remoteRunnerDiscovery.js";
import { FakeHostTransportClock } from "./support/hostTransportTestClock.js";
import { remoteRunnerEventV2Capability } from "./support/remoteRunnerEventCapabilityTestValues.js";

const validBody = JSON.stringify({ remoteRunnerEvents: remoteRunnerEventV2Capability });
const url = new URL("https://discovery.invalid/version");

function discovery(request: typeof fetch) {
  const clock = new FakeHostTransportClock();
  const controller = new AbortController();
  const added = vi.spyOn(controller.signal, "addEventListener");
  const removed = vi.spyOn(controller.signal, "removeEventListener");
  const promise = discoverRemoteRunnerEventProtocol({
    url,
    request,
    clock,
    signal: controller.signal
  });
  return {
    clock,
    controller,
    promise,
    expectReleased() {
      expect(clock.pendingTimerCount()).toBe(0);
      expect(added).toHaveBeenCalledTimes(1);
      expect(removed).toHaveBeenCalledWith("abort", added.mock.calls[0]?.[1]);
    }
  };
}

describe("single remote Runner discovery", () => {
  it("reads the capability and releases its timeout and lifecycle listener", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response(validBody));
    const run = discovery(request);
    await expect(run.promise).resolves.toBe(2);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe(url);
    expect(request.mock.calls[0]?.[1]?.headers).toEqual({ Accept: "application/json" });
    run.expectReleased();
  });

  it.each([408, 429, 500, 502, 503, 504])("retries HTTP %i", async (status) => {
    const run = discovery(async () => new Response(null, { status }));
    await expect(run.promise).rejects.toMatchObject({
      kind: "retryable",
      code: `remote_runner_discovery_http_${status}`
    });
    run.expectReleased();
  });

  it.each([401, 403])("terminates authentication failure HTTP %i", async (status) => {
    const run = discovery(async () => new Response(null, { status }));
    await expect(run.promise).rejects.toMatchObject({ kind: "auth" });
    run.expectReleased();
  });

  it.each([400, 404, 405, 409, 422, 501, 505])("terminates HTTP %i", async (status) => {
    const run = discovery(async () => new Response(null, { status }));
    await expect(run.promise).rejects.toMatchObject({ kind: "protocol" });
    run.expectReleased();
  });

  it.each([
    [429, "12", 12_000],
    [503, "999999999999999999999999999999999999", 30_000],
    [503, "Thu, 23 Jul 2026 08:00:15 GMT", 15_000],
    [429, "invalid", undefined],
    [500, "12", undefined],
    [408, "12", undefined]
  ])("uses bounded Retry-After only on 429 and 503 (%i, %s)", async (status, value, delay) => {
    if (typeof status !== "number" || typeof value !== "string") throw new Error("invalid fixture");
    const run = discovery(
      async () => new Response(null, { status, headers: { "retry-after": value } })
    );
    await expect(run.promise).rejects.toMatchObject({ retryAfterMs: delay });
    run.expectReleased();
  });

  it.each([
    ["{", "remote_runner_discovery_invalid_json"],
    ["", "remote_runner_discovery_invalid_json"],
    ["null", "remote_runner_discovery_invalid_response"],
    ["[]", "remote_runner_discovery_invalid_response"],
    ["2", "remote_runner_discovery_invalid_response"],
    ["{}", "remote_runner_event_v2_required"],
    ['{"remoteRunnerEvents":null}', "remote_runner_event_v2_required"],
    ['{"remoteRunnerEvents":{"available":false}}', "remote_runner_event_v2_required"],
    [
      JSON.stringify({
        remoteRunnerEvents: { ...remoteRunnerEventV2Capability, acceptedVersions: [1, 2] }
      }),
      "remote_runner_event_v2_required"
    ]
  ])("terminates invalid JSON or capability %s", async (body, code) => {
    const run = discovery(async () => new Response(body));
    await expect(run.promise).rejects.toMatchObject({ kind: "protocol", code });
    run.expectReleased();
  });

  it.each([
    "EAI_AGAIN",
    "ENOTFOUND",
    "ECONNREFUSED",
    "ECONNRESET",
    "ECONNABORTED",
    "ETIMEDOUT",
    "EPIPE",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_SOCKET"
  ])("classifies transport code %s without exposing error text", async (code) => {
    const run = discovery(async () => {
      throw new TypeError("fetch failed https://secret.invalid/?token=secret", {
        cause: Object.assign(new Error("secret"), { code })
      });
    });
    await expect(run.promise).rejects.toMatchObject({
      kind: "retryable",
      code: "remote_runner_discovery_network",
      message: "remote_runner_discovery_network"
    });
    run.expectReleased();
  });

  it.each([
    "ERR_INVALID_URL",
    "ERR_INVALID_PROTOCOL",
    "ERR_INVALID_ARG_TYPE",
    "ERR_INVALID_ARG_VALUE",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "CERT_HAS_EXPIRED",
    "CERT_NOT_YET_VALID",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "UNABLE_TO_GET_ISSUER_CERT",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "CERT_REVOKED",
    "ERR_SSL_WRONG_VERSION_NUMBER",
    "UND_ERR_INVALID_ARG"
  ])("terminates TLS or configuration error %s", async (code) => {
    const run = discovery(async () => {
      throw new TypeError("fetch failed", { cause: { code } });
    });
    await expect(run.promise).rejects.toMatchObject({ kind: "configuration" });
    run.expectReleased();
  });

  it("prioritizes a certificate failure inside a connection-reset cause chain", async () => {
    const run = discovery(async () => {
      throw Object.assign(
        new Error("connection reset", {
          cause: Object.assign(new Error("certificate expired"), { code: "CERT_HAS_EXPIRED" })
        }),
        { code: "ECONNRESET" }
      );
    });
    await expect(run.promise).rejects.toMatchObject({
      kind: "configuration",
      code: "remote_runner_discovery_configuration"
    });
    run.expectReleased();
  });

  it.each([
    new Error("ECONNRESET is only text"),
    new TypeError("fetch failed"),
    new DOMException("aborted externally", "AbortError"),
    { code: "SOMETHING_NEW" },
    null,
    "secret"
  ])("does not retry unknown exception %s", async (error) => {
    const run = discovery(async () => {
      throw error;
    });
    await expect(run.promise).rejects.toMatchObject({
      kind: "unknown",
      message: "remote_runner_discovery_unknown"
    });
    run.expectReleased();
  });

  it("handles cyclic causes as unknown", async () => {
    const error = new Error("cycle");
    error.cause = error;
    const run = discovery(async () => {
      throw error;
    });
    await expect(run.promise).rejects.toMatchObject({ kind: "unknown" });
    run.expectReleased();
  });

  it.each([
    "ECONNRESET",
    "UND_ERR_SOCKET",
    undefined
  ])("distinguishes a body stream error from JSON syntax (%s)", async (code) => {
    const request: typeof fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"remoteRunnerEvents":'));
            controller.error(Object.assign(new Error("body interrupted"), { code }));
          }
        })
      );
    const run = discovery(request);
    await expect(run.promise).rejects.toMatchObject({
      kind: code === undefined ? "unknown" : "retryable"
    });
    run.expectReleased();
  });

  it.each([
    "headers",
    "body"
  ] as const)("times out during %s and releases request resources", async (phase) => {
    let aborted = false;
    const request: typeof fetch = async (_input, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error("missing request signal");
      if (phase === "headers") {
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(signal.reason);
            },
            { once: true }
          );
        });
      }
      return new Response(
        new ReadableStream({
          start(controller) {
            signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                controller.error(signal.reason);
              },
              { once: true }
            );
          }
        })
      );
    };
    const run = discovery(request);
    await Promise.resolve();
    run.clock.advanceBy(9_999);
    expect(aborted).toBe(false);
    const rejection = expect(run.promise).rejects.toMatchObject({
      kind: "retryable",
      code: "remote_runner_discovery_timeout"
    });
    run.clock.advanceBy(1);
    await rejection;
    expect(aborted).toBe(true);
    run.expectReleased();
  });

  it.each([
    "headers",
    "body"
  ] as const)("cancels during %s without reporting timeout", async (phase) => {
    let aborted = false;
    const request: typeof fetch = async (_input, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error("missing request signal");
      if (phase === "headers") {
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(signal.reason);
            },
            { once: true }
          );
        });
      }
      return new Response(
        new ReadableStream({
          start(controller) {
            signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                controller.error(signal.reason);
              },
              { once: true }
            );
          }
        })
      );
    };
    const run = discovery(request);
    await Promise.resolve();
    const rejection = expect(run.promise).rejects.toMatchObject({ kind: "cancelled" });
    run.controller.abort();
    await rejection;
    expect(aborted).toBe(true);
    run.expectReleased();
  });

  describe.each(["headers", "body"] as const)("wall-clock budget after %s", (phase) => {
    it.each([
      9_999, 10_000, 15_000
    ])("checks elapsed time %i without a timer callback", async (elapsedMs) => {
      const response = new Response(validBody);
      const run = discovery(async () => response);
      const startedAt = run.clock.now().getTime();
      const jumpWithoutTimers = () => {
        vi.spyOn(run.clock, "now").mockReturnValue(new Date(startedAt + elapsedMs));
        expect(run.clock.pendingTimerCount()).toBe(1);
      };
      if (phase === "headers") {
        jumpWithoutTimers();
      } else {
        vi.spyOn(response, "text").mockImplementation(async () => {
          jumpWithoutTimers();
          return validBody;
        });
      }
      if (elapsedMs < 10_000) {
        await expect(run.promise).resolves.toBe(2);
      } else {
        await expect(run.promise).rejects.toMatchObject({
          kind: "retryable",
          code: "remote_runner_discovery_timeout"
        });
      }
      run.expectReleased();
    });
  });

  it("does not finish a timeout before the request has acknowledged cancellation", async () => {
    let rejectRequest: (error: Error) => void = () => {
      throw new Error("request not started");
    };
    let requestSignal: AbortSignal | null | undefined;
    const run = discovery(async (_input, init) => {
      requestSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        rejectRequest = reject;
      });
    });
    let finished = false;
    const completion = run.promise.catch((error: unknown) => {
      finished = true;
      return error;
    });
    run.clock.advanceBy(10_000);
    await Promise.resolve();
    expect(requestSignal?.aborted).toBe(true);
    expect(finished).toBe(false);
    rejectRequest(new Error("request released"));
    expect(await completion).toMatchObject({
      kind: "retryable",
      code: "remote_runner_discovery_timeout"
    });
    run.expectReleased();
  });

  it("does not request when the lifecycle is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const clock = new FakeHostTransportClock();
    const request = vi.fn<typeof fetch>();
    await expect(
      discoverRemoteRunnerEventProtocol({ url, request, clock, signal: controller.signal })
    ).rejects.toMatchObject({ kind: "cancelled" });
    expect(request).not.toHaveBeenCalled();
    expect(clock.pendingTimerCount()).toBe(0);
  });

  it("rejects unsupported URL protocols before making a request", async () => {
    const request = vi.fn<typeof fetch>();
    await expect(
      discoverRemoteRunnerEventProtocol({
        url: new URL("file:///version"),
        request,
        clock: new FakeHostTransportClock(),
        signal: new AbortController().signal
      })
    ).rejects.toBeInstanceOf(RemoteRunnerDiscoveryError);
    expect(request).not.toHaveBeenCalled();
  });
});

describe("remote Runner Retry-After", () => {
  const now = new Date("2026-07-23T08:00:00.000Z");
  it.each([
    [null, undefined],
    ["", undefined],
    [" ", undefined],
    ["garbage", undefined],
    ["-1", undefined],
    ["1.5", undefined],
    ["+1", undefined],
    ["1e2", undefined],
    ["2026-07-23T08:00:20Z", undefined],
    ["0", 0],
    [" 12 ", 12_000],
    ["30", 30_000],
    ["300000", 30_000],
    ["Thu, 23 Jul 2026 08:00:10 GMT", 10_000],
    ["Thu, 23 Jul 2026 08:01:00 GMT", 30_000],
    ["Thu, 23 Jul 2026 07:59:00 GMT", 0],
    ["Sun, 31 Feb 2026 08:00:00 GMT", undefined]
  ])("parses %s as %s", (value, expected) => {
    expect(parseRemoteRunnerRetryAfter(value, now)).toBe(expected);
  });
});
