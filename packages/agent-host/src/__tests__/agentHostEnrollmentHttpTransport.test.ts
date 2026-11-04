import { agentHostProtocolVersion } from "@planweave-ai/agent-host-protocol";
import { createServer, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpAgentHostEnrollmentExchange } from "../enrollment/httpEnrollmentExchange.js";
import { HttpAgentHostSetupCodeRedeem } from "../enrollment/httpSetupCodeRedeem.js";

const servers: Server[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const completed = {
  type: "host.enrollment.completed",
  protocolVersion: agentHostProtocolVersion,
  enrollmentAttemptId: "enroll-transport",
  hostId: "host-transport",
  credentialExpiresAt: "2099-01-01T00:00:00.000Z",
  credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
};
const setupCompleted = {
  schemaVersion: "workspace-setup/v1",
  purpose: "host_enrollment",
  workspaceId: "workspace-transport",
  workspaceDisplayName: "Transport",
  connectionProfile: {
    schemaVersion: "workspace-identity/v1",
    profileId: "profile-transport",
    displayName: "Transport",
    serverBaseUrl: "https://server.example/",
    workspaceId: "workspace-transport",
    allowInsecureTransport: false
  },
  enrollmentAttemptId: completed.enrollmentAttemptId,
  enrollmentId: "enrollment-transport",
  hostId: completed.hostId,
  hostCredentialExpiresAt: completed.credentialExpiresAt
};
const enrollmentCode = `pw_enroll_${"a".repeat(43)}`;
const credentialToken = `pw_host_${"b".repeat(43)}`;
const setupCode = `pw_setup_${"c".repeat(43)}`;
const adapters = [
  {
    name: "exchange",
    completed,
    invoke: (origin: string, request: typeof fetch, signal?: AbortSignal) =>
      new HttpAgentHostEnrollmentExchange(origin, {
        allowInsecureDevelopment: true,
        request
      }).exchange(
        {
          type: "host.enrollment.request",
          protocolVersion: agentHostProtocolVersion,
          enrollmentCode,
          credentialToken,
          enrollmentAttemptId: completed.enrollmentAttemptId,
          displayName: "Transport",
          capabilities: [],
          capacity: 1
        },
        signal
      )
  },
  {
    name: "setup redeem",
    completed: setupCompleted,
    invoke: (origin: string, request: typeof fetch, signal?: AbortSignal) =>
      new HttpAgentHostSetupCodeRedeem(origin, { allowInsecureDevelopment: true, request }).redeem(
        {
          schemaVersion: "workspace-setup/v1",
          purpose: "host_enrollment",
          setupCode,
          hostCredentialToken: credentialToken,
          enrollmentAttemptId: completed.enrollmentAttemptId,
          displayName: "Transport",
          capabilities: [],
          capacity: 1
        },
        signal
      )
  }
];

async function fixture(respond: (response: ServerResponse) => void) {
  const received = deferred<ServerResponse>();
  const closed = deferred<void>();
  const headers = deferred<void>();
  const server = createServer((request, response) => {
    request.resume();
    response.on("close", () => closed.resolve());
    respond(response);
    received.resolve(response);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected_port");
  const request: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    headers.resolve();
    return response;
  };
  return { origin: `http://127.0.0.1:${address.port}`, received, closed, headers, request };
}

for (const adapter of adapters) {
  describe(`real HTTP ${adapter.name}`, () => {
    it.each([
      "headers",
      "body",
      "slow chunks"
    ])("aborts the real transport at the full deadline during %s", async (stage) => {
      const server = await fixture((response) => {
        if (stage !== "headers") {
          response.writeHead(200, { "content-type": "application/json" });
          response.write(" ");
        }
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const observed = adapter
        .invoke(server.origin, server.request)
        .catch((error: unknown) => error);
      const response = await server.received.promise;
      if (stage !== "headers") await server.headers.promise;
      if (stage === "slow chunks") {
        for (let chunk = 0; chunk < 3; chunk++) {
          response.write(" ");
          await vi.advanceTimersByTimeAsync(9_000);
        }
      }
      await vi.advanceTimersByTimeAsync(stage === "slow chunks" ? 3_000 : 30_000);
      expect(await observed).toMatchObject({ message: "agent_host_enrollment_timeout" });
      // The server-side close is transport evidence, independent of the rejected Promise.
      await server.closed.promise;
      expect(response.destroyed).toBe(true);
    });

    it.each([
      "headers",
      "body"
    ])("closes the socket on owner cancellation during %s", async (stage) => {
      const server = await fixture((response) => {
        if (stage === "body") {
          response.writeHead(200, { "content-type": "application/json" });
          response.write(" ");
        }
      });
      const owner = new AbortController();
      const observed = adapter
        .invoke(server.origin, server.request, owner.signal)
        .catch((error: unknown) => error);
      const response = await server.received.promise;
      if (stage === "body") await server.headers.promise;
      owner.abort(new Error(`private ${credentialToken}`));
      const error = await observed;
      expect(error).toMatchObject({ message: "agent_host_enrollment_canceled" });
      expect(String(error)).not.toContain(credentialToken);
      await server.closed.promise;
      expect(response.destroyed).toBe(true);
    });

    it.each([
      {
        name: "declared size",
        contentType: "application/json",
        body: "{}",
        size: 16_385,
        status: 200,
        error: "response_too_large"
      },
      {
        name: "streamed size",
        contentType: "application/json",
        body: " ".repeat(16_385),
        status: 200,
        error: "response_too_large"
      },
      {
        name: "non JSON",
        contentType: "application/json",
        body: `not-json ${credentialToken}`,
        status: 200,
        error: "response_malformed"
      },
      {
        name: "content type",
        contentType: "text/plain",
        body: "{}",
        status: 200,
        error: "response_malformed"
      },
      {
        name: "schema",
        contentType: "application/json",
        body: JSON.stringify({ secret: credentialToken }),
        status: 200,
        error: "response_malformed"
      },
      {
        name: "refusal",
        contentType: "application/json",
        body: JSON.stringify({
          type: "host.enrollment.error",
          protocolVersion: agentHostProtocolVersion,
          code: "invalid",
          message: `private ${credentialToken}`,
          retryable: false
        }),
        status: 403,
        error: "rejected"
      }
    ])("enforces $name over real HTTP with redacted errors", async ({
      contentType,
      body,
      size,
      status,
      error
    }) => {
      const server = await fixture((response) => {
        response.writeHead(status, {
          "content-type": contentType,
          ...(size ? { "content-length": size } : {})
        });
        response.end(body);
      });
      const failure = await adapter
        .invoke(server.origin, server.request)
        .catch((value: unknown) => value);
      expect(failure).toMatchObject({ message: `agent_host_enrollment_${error}` });
      for (const secret of [credentialToken, enrollmentCode, setupCode])
        expect(String(failure)).not.toContain(secret);
    });

    it("accepts a complete valid response", async () => {
      const server = await fixture((response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(adapter.completed));
      });
      await expect(adapter.invoke(server.origin, server.request)).resolves.toEqual(
        adapter.completed
      );
    });
  });
}
