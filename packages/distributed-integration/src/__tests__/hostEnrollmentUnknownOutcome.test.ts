import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentHostOperator,
  loadAgentHostConfig
} from "../../../agent-host/src/operator/agentHostOperator.js";
import { FileHostCredentialStore } from "../../../agent-host/src/credentials/fileCredentialStore.js";
import {
  handoffInstanceKey,
  resolveAgentHostDefaultPaths
} from "../../../agent-host/src/config/defaultPaths.js";
import {
  hostEnrollmentRequestSchema,
  serializeAgentHostSetupHandoff
} from "@planweave-ai/agent-host-protocol";
import { OperatorControlService } from "../../../desktop/src/main/operatorControl/operatorControlService.js";
import { DesktopLocalAgentHostProvisioner } from "../../../desktop/src/main/operatorControl/localAgentHostProvisioner.js";
import { LocalAgentHostRegistrationStore } from "../../../desktop/src/main/operatorControl/localAgentHostRegistrationStore.js";
import { OperatorProfileStore } from "../../../desktop/src/main/operatorControl/operatorProfileStore.js";
import { OperatorCredentialVault } from "../../../desktop/src/main/operatorControl/operatorCredentialVault.js";
import { HostEnrollmentService } from "../../../server/src/hostEnrollment.js";
import { handleHostEnrollmentRequest } from "../../../server/src/hostEnrollmentHttp.js";
import { AgentHostRepository } from "../../../server/src/hosts.js";
import { startPlanweaveServer, type PlanweaveServer } from "../../../server/src/lifecycle.js";
import { loopbackHttpTransportAdmission } from "../../../server/src/__tests__/support/transportAdmission.js";

const home = vi.hoisted(() => ({ path: "" }));
vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  homedir: () => home.path
}));
const directories: string[] = [];
const servers: Server[] = [];
const stores: PlanweaveServer[] = [];
const desktops: OperatorControlService[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const desktop of desktops.splice(0)) await desktop.shutdown();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const store of stores.splice(0)) store.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected_port");
  return `http://127.0.0.1:${address.port}`;
}
const enrollmentRequest = {
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
};

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "planweave-enrollment-outcome-"));
  directories.push(directory);
  home.path = directory;
  vi.stubEnv("PLANWEAVE_HOME", join(directory, "desktop-home"));
  const store = await startPlanweaveServer({
    dataDirectory: join(directory, "server"),
    databasePath: join(directory, "server.sqlite"),
    busyTimeoutMs: 5_000
  });
  stores.push(store);
  const enrollment = new HostEnrollmentService(store.database);
  let grants = 0;
  const upstream = await listen(
    createServer((request, response) => {
      // Grant issuance is fixture routing; exchange uses the production HTTP handler and SQLite service.
      if (request.url === "/api/v1/host-enrollments") {
        grants++;
        const grant = enrollment.createGrant({
          expiresAt: new Date(enrollmentRequest.expiresAt),
          credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
        });
        request.resume();
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify(grant));
      } else {
        void handleHostEnrollmentRequest(request, response, {
          service: enrollment,
          transportAdmission: loopbackHttpTransportAdmission
        });
      }
    })
  );
  const committed = deferred<void>();
  const droppedConnectionClosed = deferred<void>();
  const requests: ReturnType<typeof hostEnrollmentRequestSchema.parse>[] = [];
  let exchanges = 0;
  const origin = await listen(
    createServer((request, response) => {
      const exchange = request.url === "/agent-hosts/enrollments/exchange";
      const drop = exchange && ++exchanges === 1;
      if (drop) response.on("close", () => droppedConnectionClosed.resolve());
      const bytes: Buffer[] = [];
      request.on("data", (chunk: Buffer) => {
        bytes.push(chunk);
      });
      const forward = httpRequest(
        new URL(request.url ?? "/", upstream),
        { method: request.method, headers: request.headers },
        (incoming) => {
          const body: Buffer[] = [];
          incoming.on("data", (chunk: Buffer) => body.push(chunk));
          incoming.on("end", () => {
            if (exchange)
              requests.push(
                hostEnrollmentRequestSchema.parse(JSON.parse(Buffer.concat(bytes).toString("utf8")))
              );
            if (drop) committed.resolve();
            else {
              response.writeHead(incoming.statusCode ?? 500, {
                "content-type": "application/json"
              });
              response.end(Buffer.concat(body));
            }
          });
        }
      );
      forward.on("error", () => response.destroy());
      request.pipe(forward);
    })
  );
  const endpoint = {
    topology: "loopback_http" as const,
    serverOrigin: origin,
    allowedClientOrigins: [origin],
    tlsTrust: "not_applicable" as const
  };
  const codexPath = join(directory, process.platform === "win32" ? "codex-acp.cmd" : "codex-acp");
  await writeFile(codexPath, "", { mode: 0o755 });
  const operator = new AgentHostOperator(null, process.platform, {
    PATH: directory,
    PATHEXT: ".CMD",
    NoDefaultCurrentDirectoryInExePath: "1"
  });
  const provisioner = new DesktopLocalAgentHostProvisioner({
    platform: "darwin",
    launcher: { executablePath: process.execPath, fixedArgs: [] },
    registrations: new LocalAgentHostRegistrationStore(join(directory, "registrations.json")),
    operator: {
      enrollHandoff: (handoff, options) => operator.enrollHandoff(handoff, options),
      reconcileAgentExposure: (path, ids) => operator.reconcileAgentExposure(path, ids),
      listAgents: (path) => operator.listAgents(path),
      requireUsableCredential: (path) => operator.requireUsableCredential(path),
      installBackground: async () => ({ state: "running", platform: "macos-launch-agent" }),
      backgroundStatus: async () => ({ state: "running", platform: "macos-launch-agent" })
    }
  });
  const desktop = new OperatorControlService({
    profileStore: new OperatorProfileStore({ profilesPath: join(directory, "profiles.json") }),
    vault: new OperatorCredentialVault({
      paths: { credentialsPath: join(directory, "operator.json") },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(value),
        decryptString: (value) => value.toString()
      }
    }),
    localAgentHost: provisioner
  });
  desktops.push(desktop);
  await desktop.ensureMainOwnedServerProfile({
    profile: {
      profileId: "profile-outcome",
      displayName: "Outcome",
      serverBaseUrl: origin,
      allowInsecureTransport: true,
      endpoint
    },
    operatorId: "operator-outcome",
    operatorToken: `pw_operator_${"a".repeat(43)}`
  });
  const paths = resolveAgentHostDefaultPaths(
    handoffInstanceKey({
      version: "agent-host-setup/v2",
      endpoint,
      enrollmentCode: `pw_enroll_${"a".repeat(43)}`,
      expiresAt: enrollmentRequest.expiresAt,
      credentialExpiresAt: "2030-06-30T00:00:00.000Z",
      credentialPolicy: { lifetimeDays: 180, renewal: "automatic" },
      display: { workspaceName: "Outcome", serverName: "Outcome" }
    })
  );
  const credentials = new FileHostCredentialStore(join(paths.dataDirectory, "credentials.json"));
  return {
    desktop,
    enrollment,
    endpoint,
    operator,
    codexPath: await realpath(codexPath),
    paths,
    credentials,
    store,
    requests,
    committed,
    droppedConnectionClosed,
    grants: () => grants
  };
}

async function loseFirstResponse(
  fixture: Awaited<ReturnType<typeof setup>>,
  operation: () => Promise<unknown>
) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const observed = operation().catch((error: unknown) => error);
  await Promise.race([
    fixture.committed.promise,
    observed.then((failure) => {
      throw failure;
    })
  ]);
  const pending = (await fixture.credentials.read())?.pending;
  expect(pending).toBeDefined();
  expect(new AgentHostRepository(fixture.store.database).list()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(30_000);
  const failure = await observed;
  expect(failure).toMatchObject({
    message: expect.stringContaining("agent_host_enrollment_timeout")
  });
  await fixture.droppedConnectionClosed.promise;
  vi.useRealTimers();
  const retained = (await fixture.credentials.read())?.pending;
  expect(retained?.enrollmentAttemptId).toBe(pending?.enrollmentAttemptId);
  expect(retained?.credentialToken === pending?.credentialToken).toBe(true);
  expect((await fixture.credentials.read())?.active).toBeUndefined();
  return pending;
}

function assertOneHost(fixture: Awaited<ReturnType<typeof setup>>, token: string | undefined) {
  const hosts = new AgentHostRepository(fixture.store.database);
  expect(hosts.list()).toHaveLength(1);
  expect(
    fixture.store.database.prepare("SELECT COUNT(*) AS count FROM agent_hosts").get()?.count
  ).toBe(1);
  const host = hosts.list()[0];
  if (!host || !token) throw new Error("expected_host_credential");
  expect(hosts.authenticate(host.id, token)?.id).toBe(host.id);
  expect(fixture.requests).toHaveLength(2);
  expect(fixture.requests[1]?.enrollmentAttemptId).toBe(fixture.requests[0]?.enrollmentAttemptId);
  expect(fixture.requests[1]?.installationId).toBe(fixture.requests[0]?.installationId);
  expect(fixture.requests[1]?.credentialToken === fixture.requests[0]?.credentialToken).toBe(true);
  expect(fixture.requests[1]?.enrollmentCode === fixture.requests[0]?.enrollmentCode).toBe(true);
  return host.id;
}

describe("Host enrollment unknown outcome across HTTP and SQLite", () => {
  it("reuses one pending attempt when the actual one-click Desktop entry retries", async () => {
    const fixture = await setup();
    const input = {
      profileId: "profile-outcome",
      request: enrollmentRequest,
      exposedProfileIds: ["codex-acp"]
    };
    const pending = await loseFirstResponse(fixture, () =>
      fixture.desktop.registerLocalAgentHost(input)
    );
    const status = await fixture.desktop.registerLocalAgentHost({
      ...input,
      request: {
        ...enrollmentRequest,
        expiresAt: new Date(Date.parse(enrollmentRequest.expiresAt) + 60_000).toISOString()
      }
    });
    expect(status.state).toBe("ready");
    expect((await loadAgentHostConfig(fixture.paths.configPath)).agentProfiles).toEqual(
      expect.arrayContaining([expect.objectContaining({ command: fixture.codexPath })])
    );
    expect(fixture.grants()).toBe(1);
    const active = (await fixture.credentials.read())?.active;
    expect(active?.hostId).toBe(assertOneHost(fixture, pending?.credentialToken));
    expect(active?.credentialToken === pending?.credentialToken).toBe(true);
    expect((await fixture.credentials.read())?.pending).toBeUndefined();
    expect(JSON.stringify(status)).not.toMatch(/pw_host_|pw_enroll_|credentials.json|configPath/);
  });

  it("recovers the persisted pending attempt with a new operator instance", async () => {
    const fixture = await setup();
    const grant = fixture.enrollment.createGrant({
      expiresAt: new Date(enrollmentRequest.expiresAt),
      credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
    });
    const handoff = serializeAgentHostSetupHandoff({
      version: "agent-host-setup/v2",
      endpoint: fixture.endpoint,
      ...grant,
      display: { workspaceName: "Outcome", serverName: "Outcome" }
    });
    const pending = await loseFirstResponse(fixture, () =>
      fixture.operator.enrollHandoff(handoff, { installBackground: false })
    );
    await new AgentHostOperator().resumeEnrollment(fixture.paths.configPath);
    expect((await fixture.credentials.read())?.active?.hostId).toBe(
      assertOneHost(fixture, pending?.credentialToken)
    );
    expect((await fixture.credentials.read())?.pending).toBeUndefined();
  });
});
