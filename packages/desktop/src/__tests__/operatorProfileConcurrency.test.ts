import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { OperatorLocalHostOperations } from "../main/operatorControl/operatorLocalHostOperations";
import { OperatorProfileOperations } from "../main/operatorControl/operatorProfileOperations";
import { OperatorControlService } from "../main/operatorControl/operatorControlService";
import { OperatorCredentialVault } from "../main/operatorControl/operatorCredentialVault";
import { OperatorProfileStore } from "../main/operatorControl/operatorProfileStore";

const roots: string[] = [];
const services: OperatorControlService[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdown()));
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const token = `pw_operator_${"A".repeat(43)}`;
const replacement = `pw_operator_${"B".repeat(43)}`;
const pendingToken = `pw_operator_${"P".repeat(43)}`;
const deviceId = "c28d8f73-0881-4a71-b21d-2a69f223aabc";
const authorization = {
  operatorId: "admin",
  expiresAt: "2099-02-01T00:00:00.000Z",
  renewAfter: "2099-01-22T00:00:00.000Z"
};
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const device = {
  secret: `pw_device_${"D".repeat(43)}`,
  origin: "https://a.example",
  operatorId: "admin",
  deviceId,
  pendingToken
};
const hostPage = { items: [], nextCursor: null };
function normalReply(url: RequestInfo | URL) {
  const path = new URL(String(url)).pathname;
  if (path.endsWith("/device-refresh")) return response({ ...authorization, deviceId });
  if (path.endsWith("/device-enroll"))
    return response({
      deviceId,
      deviceName: "Test",
      operatorId: "admin",
      createdAt: "2030-01-01T00:00:00Z",
      lastUsedAt: "2030-01-01T00:00:00Z",
      revokedAt: null
    });
  if (path.endsWith("/device-list")) return response([]);
  if (path.endsWith("/hosts")) return response(hostPage);
  return response(authorization);
}
async function fixture(
  request: typeof fetch,
  origins = ["https://a.example", "https://b.example", "https://c.example"]
) {
  const root = await mkdtemp(join(tmpdir(), "operator-concurrency-"));
  roots.push(root);
  const paths = { credentialsPath: join(root, "credentials.json") };
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(text),
    decryptString: (value: Buffer) => value.toString()
  };
  const vault = new OperatorCredentialVault({ paths, safeStorage });
  const profiles = new OperatorProfileStore({ profilesPath: join(root, "profiles.json") });
  const service = new OperatorControlService({
    vault,
    profileStore: profiles,
    request,
    localOperatorBackend: null
  });
  services.push(service);
  for (const [index, origin] of origins.entries()) {
    const profileId = String.fromCharCode(97 + index);
    await service.upsertProfile({
      profileId,
      displayName: profileId,
      serverBaseUrl: origin,
      operatorId: "admin",
      allowInsecureTransport: origin.startsWith("http:")
    });
    await vault.setOperatorToken(profileId, token, "admin");
  }
  return {
    root,
    paths,
    vault,
    profiles,
    service,
    reload: () => new OperatorCredentialVault({ paths, safeStorage })
  };
}

it("lets B and status finish while A hangs, then allows retry after A's 30-second timeout", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const entered = deferred<void>();
  let fail = true;
  const f = await fixture(async (url, init) => {
    if (String(url).startsWith("https://a.example") && fail) {
      entered.resolve();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true }
        );
      });
    }
    return normalReply(url);
  });
  const a = f.service.listHosts({ profileId: "a" });
  const failed = expect(a).rejects.toMatchObject({ code: "operator_timeout" });
  await entered.promise;
  await expect(f.service.listHosts({ profileId: "b" })).resolves.toEqual(hostPage);
  expect((await f.service.getStatus()).profiles).toHaveLength(3);
  await vi.advanceTimersByTimeAsync(30_000);
  await failed;
  fail = false;
  await expect(f.service.listHosts({ profileId: "a" })).resolves.toEqual(hostPage);
});

it("coalesces ten same-profile checks into one refresh without blocking another profile", async () => {
  const entered = deferred<void>();
  const release = deferred<Response>();
  let refreshes = 0;
  const f = await fixture(async (url) => {
    if (String(url).includes("a.example") && String(url).endsWith("device-refresh")) {
      refreshes++;
      entered.resolve();
      return release.promise;
    }
    return normalReply(url);
  });
  await f.vault.setManagementDevice("a", device);
  const checks = Array.from({ length: 10 }, () =>
    f.service.getManagementAuthorization({ profileId: "a" })
  );
  await entered.promise;
  await expect(f.service.getManagementAuthorization({ profileId: "b" })).resolves.toMatchObject({
    authorization
  });
  release.resolve(response({ ...authorization, deviceId }));
  expect((await Promise.all(checks)).every((view) => view.errorCode === null)).toBe(true);
  expect(refreshes).toBe(1);
  expect(await f.reload().getOperatorToken("a")).toBe(pendingToken);
  expect(await f.reload().getManagementDevice("b")).toBeDefined();
});

it.each([
  "main-owned",
  "deployment"
])("keeps an authorization refresh alive during unchanged %s profile synchronization", async (source) => {
  const entered = deferred<void>();
  const release = deferred<Response>();
  let signal: AbortSignal | null | undefined;
  const f = await fixture(async (url, init) => {
    if (String(url).endsWith("device-refresh")) {
      signal = init?.signal;
      entered.resolve();
      return release.promise;
    }
    return normalReply(url);
  });
  const profile = {
    profileId: "a",
    displayName: "Local Server",
    serverBaseUrl: "https://a.example",
    allowInsecureTransport: false,
    operatorId: "admin",
    endpoint: {
      topology: "public_https" as const,
      serverOrigin: "https://a.example",
      allowedClientOrigins: ["https://a.example"],
      tlsTrust: "system_ca" as const
    }
  };
  const synchronize = () =>
    source === "main-owned"
      ? f.service.ensureMainOwnedServerProfile({
          profile,
          operatorId: "admin",
          operatorToken: token
        })
      : f.service.ensureDeploymentProfile({ profile, operatorId: "admin" });
  await synchronize();
  await f.vault.setOperatorToken("a", replacement, "admin");
  await f.vault.setManagementDevice("a", device);
  const checking = f.service.getManagementAuthorization({ profileId: "a" });
  await entered.promise;
  await synchronize();
  expect(signal?.aborted).toBe(false);
  profile.displayName = "Renamed Server";
  await synchronize();
  expect(signal?.aborted).toBe(false);
  expect(await f.vault.getOperatorToken("a")).toBe(replacement);
  release.resolve(response({ ...authorization, deviceId }));
  expect((await checking).errorCode).toBeNull();
  expect(await f.reload().getOperatorToken("a")).toBe(pendingToken);
});

it.each([
  "origin",
  "identity",
  "missing-credential"
])("invalidates authorization when main-owned synchronization changes %s", async (change) => {
  const entered = deferred<void>();
  const late = deferred<Response>();
  let signal: AbortSignal | null | undefined;
  const f = await fixture(async (url, init) => {
    if (String(url).endsWith("device-refresh")) {
      signal = init?.signal;
      entered.resolve();
      return late.promise;
    }
    return normalReply(url);
  });
  const synchronize = (origin: string, operatorId: string) =>
    f.service.ensureMainOwnedServerProfile({
      profile: {
        profileId: "a",
        displayName: "Local Server",
        serverBaseUrl: origin,
        allowInsecureTransport: false,
        operatorId,
        endpoint: {
          topology: "public_https",
          serverOrigin: origin,
          allowedClientOrigins: [origin],
          tlsTrust: "system_ca"
        }
      },
      operatorId,
      operatorToken: replacement
    });
  await synchronize("https://a.example", "admin");
  await f.vault.setManagementDevice("a", device);
  const checking = f.service.getManagementAuthorization({ profileId: "a" });
  await entered.promise;
  if (change === "missing-credential") await f.vault.clear("a");
  await synchronize(
    change === "origin" ? "https://moved.example" : "https://a.example",
    change === "identity" ? "new-admin" : "admin"
  );
  expect(signal?.aborted).toBe(true);
  expect((await checking).errorCode).toBe("operator_operation_invalidated");
  late.resolve(response({ ...authorization, deviceId }));
  await f.service.listHosts({ profileId: "b" });
  expect(await f.reload().getOperatorToken("a")).toBe(change === "origin" ? token : replacement);
});

it.each([
  "main-owned",
  "deployment"
])("serializes consecutive %s synchronizations without dropping newer configuration", async (source) => {
  const f = await fixture(async (url) => normalReply(url));
  const synchronize = (origin: string) => {
    const profile = {
      profileId: "a",
      displayName: "Server",
      serverBaseUrl: origin,
      allowInsecureTransport: false,
      operatorId: "admin",
      endpoint: {
        topology: "public_https" as const,
        serverOrigin: origin,
        allowedClientOrigins: [origin],
        tlsTrust: "system_ca" as const
      }
    };
    return source === "main-owned"
      ? f.service.ensureMainOwnedServerProfile({
          profile,
          operatorId: "admin",
          operatorToken: token
        })
      : f.service.ensureDeploymentProfile({ profile, operatorId: "admin" });
  };
  await Promise.all([
    synchronize("https://a.example"),
    synchronize("https://a.example"),
    synchronize("https://moved.example")
  ]);
  expect((await f.profiles.get("a"))?.serverBaseUrl).toBe("https://moved.example");
});

it.each([
  "clear",
  "remove",
  "import"
])("gives explicit %s priority over a queued synchronization", async (change) => {
  const f = await fixture(async (url) => normalReply(url));
  const synchronizing = f.service.ensureDeploymentProfile({
    profile: {
      profileId: "a",
      displayName: "Queued",
      serverBaseUrl: "https://moved.example",
      allowInsecureTransport: false
    },
    operatorId: "admin"
  });
  const rejected = expect(synchronizing).rejects.toMatchObject({
    code: "operator_operation_invalidated"
  });
  if (change === "clear") await f.service.clearCredential({ profileId: "a" });
  if (change === "remove") await f.service.removeProfile({ profileId: "a" });
  if (change === "import")
    await f.service.importCredential({
      profileId: "a",
      operatorToken: replacement,
      operatorId: "admin"
    });
  await rejected;
  expect(await f.vault.getOperatorToken("a")).toBe(change === "import" ? replacement : undefined);
  expect((await f.profiles.get("a"))?.serverBaseUrl).toBe(
    change === "remove" ? undefined : "https://a.example"
  );
});

it.each([
  "clear",
  "remove",
  "upsert",
  "import"
])("prioritizes %s over a refresh that ignores abort", async (change) => {
  const entered = deferred<void>();
  const late = deferred<Response>();
  let signal: AbortSignal | null | undefined;
  const f = await fixture(async (url, init) => {
    if (String(url).endsWith("device-refresh")) {
      signal = init?.signal;
      entered.resolve();
      return late.promise;
    }
    return normalReply(url);
  });
  await f.vault.setManagementDevice("a", device);
  const checking = f.service.getManagementAuthorization({ profileId: "a" });
  await entered.promise;
  if (change === "clear") await f.service.clearCredential({ profileId: "a" });
  if (change === "remove") await f.service.removeProfile({ profileId: "a" });
  if (change === "upsert")
    await f.service.upsertProfile({
      profileId: "a",
      displayName: "Moved",
      serverBaseUrl: "https://moved.example",
      allowInsecureTransport: false,
      operatorId: "new-admin"
    });
  if (change === "import")
    await f.service.importCredential({
      profileId: "a",
      operatorToken: replacement,
      operatorId: "admin",
      verifyBeforeSave: true
    });
  expect(signal?.aborted).toBe(true);
  expect((await checking).errorCode).toBe("operator_operation_invalidated");
  late.resolve(response({ ...authorization, deviceId }));
  await f.service.listHosts({ profileId: "b" });
  expect(await f.reload().getOperatorToken("a")).toBe(
    change === "clear" || change === "remove"
      ? undefined
      : change === "import"
        ? replacement
        : token
  );
});

it("does not let an old finally remove the replacement profile's in-flight check", async () => {
  const firstEntered = deferred<void>();
  const secondEntered = deferred<void>();
  const first = deferred<Response>();
  const second = deferred<Response>();
  let calls = 0;
  const f = await fixture(async (url) => {
    if (String(url).endsWith("device-refresh")) {
      calls++;
      if (calls === 1) {
        firstEntered.resolve();
        return first.promise;
      }
      secondEntered.resolve();
      return second.promise;
    }
    return normalReply(url);
  });
  await f.vault.setManagementDevice("a", device);
  const old = f.service.getManagementAuthorization({ profileId: "a" });
  await firstEntered.promise;
  await f.service.importCredential({
    profileId: "a",
    operatorToken: replacement,
    operatorId: "admin"
  });
  const current = f.service.getManagementAuthorization({ profileId: "a" });
  await secondEntered.promise;
  first.resolve(response({ ...authorization, deviceId }));
  await old;
  await f.service.listHosts({ profileId: "b" });
  const joined = f.service.getManagementAuthorization({ profileId: "a" });
  second.resolve(response({ ...authorization, deviceId }));
  await Promise.all([current, joined]);
  expect(calls).toBe(2);
});

it("bounds maintenance to two workers without blocking foreground C, and stops polling on shutdown", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const both = deferred<void>();
  const late = deferred<Response>();
  let refreshes = 0;
  const signals: AbortSignal[] = [];
  const f = await fixture(async (url, init) => {
    if (String(url).endsWith("device-refresh") && !String(url).includes("c.example")) {
      refreshes++;
      if (init?.signal) signals.push(init.signal);
      if (refreshes === 2) both.resolve();
      return late.promise;
    }
    return normalReply(url);
  });
  await f.vault.setManagementDevice("a", device);
  await f.vault.setManagementDevice("b", { ...device, origin: "https://b.example" });
  f.service.startAuthorizationMaintenance();
  f.service.startAuthorizationMaintenance();
  await vi.advanceTimersByTimeAsync(1000);
  await both.promise;
  await expect(f.service.listHosts({ profileId: "c" })).resolves.toEqual(hostPage);
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(refreshes).toBe(2);
  await f.service.shutdown();
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  late.resolve(response({ ...authorization, deviceId }));
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(refreshes).toBe(2);
  expect(vi.getTimerCount()).toBe(0);
  await expect(f.service.listHosts({ profileId: "c" })).rejects.toMatchObject({
    code: "operator_service_closed"
  });
});

it("invalidates an in-flight verified import without saving its late replacement", async () => {
  const entered = deferred<void>();
  const late = deferred<Response>();
  const f = await fixture(async (url) => {
    if (String(url).includes("a.example")) {
      entered.resolve();
      return late.promise;
    }
    return normalReply(url);
  });
  const importing = f.service.importCredential({
    profileId: "a",
    operatorToken: replacement,
    verifyBeforeSave: true
  });
  const rejected = expect(importing).rejects.toMatchObject({
    code: "operator_operation_invalidated"
  });
  await entered.promise;
  await f.service.clearCredential({ profileId: "a" });
  await rejected;
  late.resolve(response(hostPage));
  await f.service.listHosts({ profileId: "b" });
  expect(await f.reload().getOperatorToken("a")).toBeUndefined();
});

it("retries the saved pending token after a successful refresh response fails to persist", async () => {
  const entered = deferred<void>();
  const late = deferred<Response>();
  const tokens: string[] = [];
  let delay = true;
  const f = await fixture(async (url, init) => {
    if (String(url).endsWith("device-refresh")) {
      tokens.push(JSON.parse(String(init?.body)).newToken);
      if (delay) {
        entered.resolve();
        return late.promise;
      }
    }
    return normalReply(url);
  });
  await f.vault.setManagementDevice("a", device);
  const checking = f.service.getManagementAuthorization({ profileId: "a" });
  await entered.promise;
  await mkdir(`${f.paths.credentialsPath}.tmp`);
  late.resolve(response({ ...authorization, deviceId }));
  expect((await checking).errorCode).toBe("operator_management_failed");
  expect(await f.vault.getOperatorToken("a")).toBe(token);
  expect((await f.reload().getManagementDevice("a"))?.pendingToken).toBe(pendingToken);
  await rename(`${f.paths.credentialsPath}.tmp`, join(f.root, "blocked-temp"));
  delay = false;
  expect((await f.service.getManagementAuthorization({ profileId: "a" })).errorCode).toBeNull();
  expect(tokens).toEqual([pendingToken, pendingToken]);
});

it("reauthorizes two targets through each other's candidate without holding nested profile locks", async () => {
  const both = deferred<void>();
  let authorizeCalls = 0;
  const f = await fixture(
    async (url) => {
      if (String(url).endsWith("/authorize")) {
        authorizeCalls++;
        if (authorizeCalls <= 2) {
          if (authorizeCalls === 2) both.resolve();
          await both.promise;
          return response({ error: "operator_unauthorized" }, 401);
        }
      }
      return normalReply(url);
    },
    ["https://same.example", "https://same.example"]
  );
  const result = await Promise.all([
    f.service.reauthorizeManagement({ profileId: "a" }),
    f.service.reauthorizeManagement({ profileId: "b" })
  ]);
  expect(result.every((view) => view.errorCode === null)).toBe(true);
  expect(authorizeCalls).toBe(4);
});

it("cancels a real loopback fetch during shutdown without waiting for its response", async () => {
  const entered = deferred<void>();
  const closed = deferred<void>();
  const server = createServer((_request, res) => {
    entered.resolve();
    res.on("close", () => closed.resolve());
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing loopback address");
  const f = await fixture(fetch, [`http://127.0.0.1:${address.port}`]);
  const pending = f.service.listHosts({ profileId: "a" });
  const rejected = expect(pending).rejects.toMatchObject({
    code: "operator_operation_invalidated"
  });
  await entered.promise;
  await f.service.shutdown();
  await rejected;
  await closed.promise;
});

it.each([
  "maintain",
  "device-enroll",
  "device-refresh"
])("fences clear at the %s stage before any late success can recreate credentials", async (stage) => {
  const entered = deferred<void>();
  const late = deferred<Response>();
  const f = await fixture(async (url) => {
    if (String(url).endsWith(`/${stage}`)) {
      entered.resolve();
      return late.promise;
    }
    return normalReply(url);
  });
  const checking = f.service.getManagementAuthorization({ profileId: "a" });
  await entered.promise;
  await f.service.clearCredential({ profileId: "a" });
  late.resolve(normalReply(`https://a.example/${stage}`));
  expect((await checking).errorCode).toBe("operator_operation_invalidated");
  await f.service.listHosts({ profileId: "b" });
  expect(await f.reload().getOperatorToken("a")).toBeUndefined();
  expect(await f.reload().getManagementDevice("a")).toBeUndefined();
});

it("retries an expired pending token only on explicit token conflict", async () => {
  const tokens: string[] = [];
  const f = await fixture(async (url, init) => {
    if (String(url).endsWith("/device-refresh")) {
      tokens.push(JSON.parse(String(init?.body)).newToken);
      if (tokens.length === 1)
        return response({ error: "operator_management_token_conflict" }, 409);
    }
    return normalReply(url);
  });
  await f.vault.setManagementDevice("a", device);
  expect((await f.service.getManagementAuthorization({ profileId: "a" })).errorCode).toBeNull();
  expect(tokens).toHaveLength(2);
  expect(tokens[0]).toBe(pendingToken);
  expect(tokens[1]).not.toBe(pendingToken);
  expect(await f.reload().getOperatorToken("a")).toBe(tokens[1]);
});

it("recovers a lost enrollment response with the persisted secret and pending token", async () => {
  let enrollments = 0;
  const secrets: string[] = [];
  const tokens: string[] = [];
  const f = await fixture(async (url, init) => {
    if (String(url).endsWith("/device-enroll")) {
      enrollments++;
      secrets.push(JSON.parse(String(init?.body)).deviceSecret);
      if (enrollments === 1) throw new TypeError("lost enrollment response");
      if (enrollments === 2) return response({ error: "operator_unauthorized" }, 401);
    }
    if (String(url).endsWith("/device-refresh"))
      tokens.push(JSON.parse(String(init?.body)).newToken);
    return normalReply(url);
  });
  expect((await f.service.getManagementAuthorization({ profileId: "a" })).errorCode).toBe(
    "operator_offline"
  );
  const saved = await f.vault.getManagementDevice("a");
  expect(saved?.deviceId).toBeNull();
  expect((await f.service.getManagementAuthorization({ profileId: "a" })).errorCode).toBeNull();
  expect(new Set(secrets).size).toBe(1);
  expect(tokens.every((value) => value === saved?.pendingToken)).toBe(true);
});

it("serializes shared local Host mutations and rejects a cleared profile before its queued mutation starts", async () => {
  const operations = new OperatorProfileOperations();
  const localHost = new OperatorLocalHostOperations(operations);
  const first = deferred<void>();
  const entered = deferred<void>();
  const a = operations.capture("a");
  const b = operations.capture("b");
  const secondAction = vi.fn(async () => undefined);
  const running = localHost.run(a, async () => {
    entered.resolve();
    await first.promise;
  });
  await entered.promise;
  const queued = localHost.run(b, secondAction);
  const rejected = expect(queued).rejects.toMatchObject({ code: "operator_operation_invalidated" });
  operations.invalidate("b");
  await expect(operations.run("c", async () => "foreground")).resolves.toBe("foreground");
  first.resolve();
  await running;
  await rejected;
  expect(secondAction).not.toHaveBeenCalled();
  operations.shutdown();
});
