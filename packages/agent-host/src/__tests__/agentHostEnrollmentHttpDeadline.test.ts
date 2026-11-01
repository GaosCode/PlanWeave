import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpAgentHostEnrollmentExchange } from "../enrollment/httpEnrollmentExchange.js";
import { HttpAgentHostSetupCodeRedeem } from "../enrollment/httpSetupCodeRedeem.js";

const origin = "https://coordinator.example.com";
const completed = {
  type: "host.enrollment.completed",
  protocolVersion: 1,
  enrollmentAttemptId: "enroll-http-deadline",
  hostId: "host-deadline",
  credentialExpiresAt: "2099-01-01T00:00:00.000Z",
  credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
};
const setupCompleted = {
  schemaVersion: "workspace-setup/v1",
  purpose: "host_enrollment",
  workspaceId: "workspace-deadline",
  workspaceDisplayName: "Test",
  connectionProfile: {
    schemaVersion: "workspace-identity/v1",
    profileId: "profile-deadline",
    displayName: "Test",
    serverBaseUrl: origin,
    workspaceId: "workspace-deadline",
    allowInsecureTransport: false
  },
  enrollmentAttemptId: completed.enrollmentAttemptId,
  enrollmentId: "enrollment-deadline",
  hostId: completed.hostId,
  hostCredentialExpiresAt: completed.credentialExpiresAt
};
const adapters = [
  {
    name: "enrollment exchange",
    completed,
    invoke: (request: typeof fetch, signal?: AbortSignal) =>
      new HttpAgentHostEnrollmentExchange(origin, { request }).exchange(
        {
          type: "host.enrollment.request",
          protocolVersion: 1,
          installationId: "6e73ea82-1ef0-46a9-a56a-6b765caab6ef",
          enrollmentCode: `pw_enroll_${"a".repeat(43)}`,
          enrollmentAttemptId: completed.enrollmentAttemptId,
          credentialToken: `pw_host_${"b".repeat(43)}`,
          displayName: "Test",
          capabilities: [],
          capacity: 1
        },
        signal
      )
  },
  {
    name: "setup-code redeem",
    completed: setupCompleted,
    invoke: (request: typeof fetch, signal?: AbortSignal) =>
      new HttpAgentHostSetupCodeRedeem(origin, { request }).redeem(
        {
          schemaVersion: "workspace-setup/v1",
          setupCode: `pw_setup_${"c".repeat(43)}`,
          purpose: "host_enrollment",
          enrollmentAttemptId: completed.enrollmentAttemptId,
          hostCredentialToken: `pw_host_${"b".repeat(43)}`,
          displayName: "Test",
          capabilities: [],
          capacity: 1
        },
        signal
      )
  }
];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

for (const adapter of adapters) {
  describe(adapter.name, () => {
    it.each([
      "headers",
      "body",
      "slow body"
    ])("bounds non-cooperating %s by one full-request deadline", async (stage) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const headers = deferred<Response>();
      const cancel = vi.fn(() => new Promise<void>(() => {}));
      let stream!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
        },
        cancel
      });
      const response = new Response(body, { headers: { "content-type": "application/json" } });
      let signal: AbortSignal | undefined;
      let settled = false;
      let error: unknown;
      const operation = adapter
        .invoke(async (_input, init) => {
          signal = init?.signal ?? undefined;
          return stage === "headers" ? headers.promise : response;
        })
        .catch((failure: unknown) => {
          error = failure;
        })
        .finally(() => {
          settled = true;
        });
      await vi.advanceTimersByTimeAsync(0);
      if (stage === "slow body") {
        for (let i = 0; i < 3; i++) {
          stream.enqueue(new TextEncoder().encode(" "));
          await vi.advanceTimersByTimeAsync(9000);
        }
      }
      await vi.advanceTimersByTimeAsync(stage === "slow body" ? 3001 : 30001);
      const settledAtDeadline = settled;
      if (!settled) {
        if (stage === "headers") headers.resolve(json(adapter.completed));
        else stream.close();
      } else if (stage === "headers") headers.resolve(response);
      await operation;
      await Promise.resolve();
      expect(settledAtDeadline).toBe(true);
      expect(error).toMatchObject({ message: "agent_host_enrollment_timeout" });
      expect(signal?.aborted).toBe(true);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(body.locked).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each([
      "before request",
      "during body"
    ])("normalizes owner cancellation %s", async (stage) => {
      const controller = new AbortController();
      const cancel = vi.fn();
      const entered = deferred<void>();
      let stream!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(value) {
          stream = value;
        },
        cancel
      });
      const request = vi.fn<typeof fetch>(async () => {
        entered.resolve();
        return new Response(body, { headers: { "content-type": "application/json" } });
      });
      if (stage === "before request") controller.abort(new Error("secret-owner-reason"));
      const operation = adapter.invoke(request, controller.signal);
      const observed = operation.catch((failure: unknown) => failure);
      if (stage === "during body") {
        await entered.promise;
        await Promise.resolve();
        controller.abort(new Error("secret-owner-reason"));
        // Close the fixture stream if cancellation has not released its reader.
        await Promise.resolve();
        if (body.locked) stream.close();
      } else stream.close();
      expect(await observed).toMatchObject({ message: "agent_host_enrollment_canceled" });
      if (stage === "before request") expect(request).not.toHaveBeenCalled();
      expect(body.locked).toBe(false);
    });

    it("clears its timer on success and preserves confirmed refusal over elapsed time", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await expect(adapter.invoke(async () => json(adapter.completed))).resolves.toEqual(
        adapter.completed
      );
      expect(vi.getTimerCount()).toBe(0);
      let elapsed = 0;
      vi.spyOn(performance, "now").mockImplementation(() => elapsed);
      const refused = json(
        {
          type: "host.enrollment.error",
          protocolVersion: 1,
          code: "invalid",
          message: "Rejected",
          retryable: false
        },
        403
      );
      Object.defineProperty(refused, "ok", {
        get() {
          elapsed = 30001;
          return false;
        }
      });
      await expect(adapter.invoke(async () => refused)).rejects.toThrow(
        "agent_host_enrollment_rejected"
      );
      expect(vi.getTimerCount()).toBe(0);
    });

    it("checks the absolute deadline between immediate body chunks", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let elapsed = 0;
      vi.spyOn(performance, "now").mockImplementation(() => elapsed);
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          elapsed += 11000;
          if (elapsed <= 44000) controller.enqueue(new Uint8Array(0));
          else controller.close();
        },
        cancel
      });
      await expect(
        adapter.invoke(
          async () => new Response(body, { headers: { "content-type": "application/json" } })
        )
      ).rejects.toThrow("agent_host_enrollment_timeout");
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(body.locked).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each([
      "declared",
      "streamed"
    ])("cancels %s oversized bodies without awaiting cleanup", async (kind) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const cleanup = deferred<void>();
      const cancel = vi.fn(() => cleanup.promise);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (kind === "streamed") controller.enqueue(new Uint8Array(16385));
        },
        cancel
      });
      let settled = false;
      const operation = adapter
        .invoke(
          async () =>
            new Response(body, {
              headers: {
                "content-type": "application/json",
                ...(kind === "declared" ? { "content-length": "16385" } : {})
              }
            })
        )
        .catch((error: unknown) => error)
        .finally(() => {
          settled = true;
        });
      await vi.advanceTimersByTimeAsync(0);
      const settledBeforeCleanup = settled;
      cleanup.resolve();
      const error = await operation;
      expect(settledBeforeCleanup).toBe(true);
      expect(error).toMatchObject({ message: "agent_host_enrollment_response_too_large" });
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(body.locked).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("reports malformed schemas without exposing raw responses", async () => {
      await expect(adapter.invoke(async () => json({ secret: "do-not-display" }))).rejects.toThrow(
        "agent_host_enrollment_response_malformed"
      );
    });
  });
}
