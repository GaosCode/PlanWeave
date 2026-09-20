import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseServerConfig, serverConfigFileInput } from "../config.js";
import { runServerCli } from "../bin.js";
import { afterEach, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { applyMigrations } from "../migrations.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";
import { OperatorTokenRegistry, hashOperatorToken } from "../operatorAuth.js";
import { OperatorSessionStore } from "../identity/operatorSessionStore.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { handleOperatorAuthorizationHttpRequest } from "../operatorAuthorizationHttp.js";
import { createTransportAdmissionPolicyForMode } from "../insecureTransport.js";

const rootToken = `pw_operator_${"A".repeat(43)}`;
const childToken = `pw_operator_${"B".repeat(43)}`;
const memberToken = `pw_operator_${"C".repeat(43)}`;
const directories: string[] = [];
const databases: SqliteDatabase[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  for (const db of databases.splice(0)) db.close();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
async function fixture() {
  const database = await openServerDatabase(":memory:", 5000);
  databases.push(database);
  applyMigrations(database);
  let now = new Date("2030-01-01T00:00:00.000Z");
  const clock = () => now;
  const workspaceId = new WorkspaceIdentityRepository(database).ensureConfiguredWorkspace(
    "test-workspace"
  );
  const sessions = new OperatorSessionStore(database, clock);
  const root = sessions.create({
    workspaceId,
    operatorId: "admin",
    credentialSha256: hashOperatorToken(rootToken),
    issuedAt: now.toISOString(),
    expiresAt: "2030-01-01T01:00:00.000Z"
  });
  sessions.create({
    workspaceId,
    operatorId: "member",
    credentialSha256: hashOperatorToken(memberToken),
    issuedAt: now.toISOString(),
    expiresAt: "2030-01-02T00:00:00.000Z"
  });
  const credentials = [
    {
      operatorId: "admin",
      tokenSha256: hashOperatorToken(rootToken),
      projectIds: [],
      serverAdmin: true
    }
  ];
  const registry = new OperatorTokenRegistry(database, credentials, clock, 3600_000);
  return {
    database,
    sessions,
    registry,
    root,
    credentials,
    clock,
    setTime: (value: string) => {
      now = new Date(value);
    }
  };
}

it("renews only active admin sessions in the renewal window and does not revive expiry or revocation", async () => {
  const f = await fixture();
  const initial = f.registry.management.maintain(f.registry.authenticate(`Bearer ${rootToken}`)!);
  expect(initial.expiresAt).toBe("2030-01-01T01:00:00.000Z");
  f.setTime("2030-01-01T00:50:00.000Z");
  const principal = f.registry.authenticate(`Bearer ${rootToken}`)!;
  expect(f.registry.management.maintain(principal).expiresAt).toBe("2030-01-01T01:50:00.000Z");
  f.setTime("2030-01-01T02:00:00.000Z");
  expect(() => f.registry.management.maintain(principal)).toThrow("operator_unauthorized");
  f.sessions.revoke(f.root.workspaceId, f.root.operatorSessionId);
  expect(f.registry.authenticate(`Bearer ${rootToken}`)).toBeUndefined();
});

it("delegates durable authority, but rejects members and invalidates children after root revocation or config replacement", async () => {
  const f = await fixture();
  const member = f.registry.authenticate(`Bearer ${memberToken}`)!;
  expect(() => f.registry.management.authorize(member, "admin", childToken)).toThrow(
    "operator_server_admin_required"
  );
  f.registry.management.authorize(
    f.registry.authenticate(`Bearer ${rootToken}`)!,
    "admin",
    childToken
  );
  const restarted = new OperatorTokenRegistry(f.database, f.credentials, f.clock, 3600_000);
  expect(restarted.authenticate(`Bearer ${childToken}`)?.serverAdmin).toBe(true);
  const changed = new OperatorTokenRegistry(
    f.database,
    [{ ...f.credentials[0], tokenSha256: "f".repeat(64) }],
    f.clock
  );
  expect(changed.authenticate(`Bearer ${childToken}`)?.serverAdmin).toBe(false);
  const stale = restarted.authenticate(`Bearer ${childToken}`)!;
  f.sessions.revoke(f.root.workspaceId, f.root.operatorSessionId);
  expect(restarted.authenticate(`Bearer ${childToken}`)?.serverAdmin).toBe(false);
  expect(() => restarted.management.maintain(stale)).toThrow("operator_unauthorized");
  expect(() =>
    restarted.management.authorize(stale, "admin", `pw_operator_${"D".repeat(43)}`)
  ).toThrow("operator_server_admin_required");
  expect(
    restarted.canRespond({
      responderId: "admin",
      workspaceId: f.root.workspaceId,
      projectId: "anything"
    })
  ).toBe(false);
});

it("recovers an expired admin with a one-time, hash-only code and supports only identical retries", async () => {
  const f = await fixture();
  f.setTime("2030-01-02T00:00:00.000Z");
  const { recoveryCode } = f.registry.management.createRecoveryCode("admin");
  expect(
    JSON.stringify(f.database.prepare("SELECT * FROM operator_management_recovery_codes").all())
  ).not.toContain(recoveryCode);
  const result = f.registry.management.recover("admin", recoveryCode, childToken);
  expect(f.registry.authenticate(`Bearer ${rootToken}`)).toBeUndefined();
  expect(f.registry.authenticate(`Bearer ${childToken}`)?.serverAdmin).toBe(true);
  expect(f.registry.management.recover("admin", recoveryCode, childToken)).toEqual(result);
  expect(() =>
    f.registry.management.recover("admin", recoveryCode, `pw_operator_${"D".repeat(43)}`)
  ).toThrow("operator_recovery_invalid");
  const second = f.registry.management.createRecoveryCode("admin");
  f.setTime("2030-01-02T00:10:00.000Z");
  expect(() => f.registry.management.recover("admin", second.recoveryCode, childToken)).toThrow(
    "operator_recovery_invalid"
  );
});

it("enforces transport, authentication and strict payloads at HTTP boundary; recovers without an expired bearer", async () => {
  const f = await fixture();
  let policy = createTransportAdmissionPolicyForMode("loopback_http");
  const server = createServer((request, response) => {
    void handleOperatorAuthorizationHttpRequest(request, response, {
      authorization: f.registry,
      transportAdmission: policy
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("address");
  const post = (action: string, body: unknown, token?: string) =>
    fetch(`http://127.0.0.1:${address.port}/api/v1/management-authorization/${action}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify(body)
    });
  expect((await post("maintain", {})).status).toBe(401);
  expect((await post("maintain", {}, memberToken)).status).toBe(403);
  expect((await post("maintain", { smuggled: true }, rootToken)).status).toBe(400);
  const valid = await post("maintain", {}, rootToken);
  expect(valid.status).toBe(200);
  expect(valid.headers.get("cache-control")).toBe("no-store");
  policy = createTransportAdmissionPolicyForMode("direct_https");
  expect((await post("maintain", {}, rootToken)).status).toBe(426);
  policy = createTransportAdmissionPolicyForMode("loopback_http");
  f.setTime("2030-01-02T00:00:00.000Z");
  const code = f.registry.management.createRecoveryCode("admin");
  expect(
    (
      await post("recover", {
        operatorId: "admin",
        newToken: childToken,
        recoveryCode: code.recoveryCode
      })
    ).status
  ).toBe(200);
  expect(f.registry.authenticate(`Bearer ${childToken}`)?.serverAdmin).toBe(true);
});

it("creates a recovery code through the installed CLI without changing configuration or renewing the old token", async () => {
  const root = await mkdtemp(join(tmpdir(), "management-cli-"));
  directories.push(root);
  const config = parseServerConfig({
    version: "server-config/v2",
    transport: {
      mode: "loopback_http",
      listener: { protocol: "http", host: "127.0.0.1", port: 8787 },
      advertisedOrigin: "http://127.0.0.1:8787/"
    },
    deployment: {
      topology: "loopback_http",
      serverOrigin: "http://127.0.0.1:8787/",
      allowedClientOrigins: ["http://127.0.0.1:8787/"],
      tlsTrust: "not_applicable"
    },
    allowedClientOrigins: null,
    dataDirectory: join(root, "data"),
    trustedProjects: [],
    operatorCredentials: [
      {
        operatorId: "admin",
        tokenSha256: hashOperatorToken(rootToken),
        projectIds: [],
        serverAdmin: true
      }
    ]
  });
  const path = join(root, "server.json");
  const original = JSON.stringify(serverConfigFileInput(config));
  await writeFile(path, original);
  const database = await openServerDatabase(config.databasePath, 5000);
  databases.push(database);
  applyMigrations(database);
  const workspaceId = new WorkspaceIdentityRepository(database).ensureConfiguredWorkspace(
    "test-workspace"
  );
  const sessions = new OperatorSessionStore(database);
  sessions.create({
    workspaceId,
    operatorId: "admin",
    credentialSha256: hashOperatorToken(rootToken),
    issuedAt: "2020-01-01T00:00:00.000Z",
    expiresAt: "2020-01-02T00:00:00.000Z"
  });
  const output: string[] = [];
  const errors: string[] = [];
  const io = {
    stdout: (value: string) => output.push(value),
    stderr: (value: string) => errors.push(value)
  };
  expect(
    await runServerCli(["auth", "recover", "--operator", "admin", "--config", path], { io })
  ).toBe(0);
  expect(errors).toEqual([]);
  const result = JSON.parse(output[0]);
  const registry = new OperatorTokenRegistry(database, config.operatorCredentials);
  registry.management.recover("admin", result.recoveryCode, childToken);
  expect(registry.authenticate(`Bearer ${childToken}`)?.serverAdmin).toBe(true);
  expect(registry.authenticate(`Bearer ${rootToken}`)).toBeUndefined();
  expect(await readFile(path, "utf8")).toBe(original);
  expect(
    await runServerCli(["auth", "recover", "--operator", "missing", "--config", path], { io })
  ).toBe(1);
});

it("invalidates outstanding recovery codes on revocation but permits explicit local recovery afterward", async () => {
  const f = await fixture();
  const before = f.registry.management.createRecoveryCode("admin");
  f.sessions.revoke(f.root.workspaceId, f.root.operatorSessionId);
  expect(() => f.registry.management.recover("admin", before.recoveryCode, childToken)).toThrow(
    "operator_recovery_invalid"
  );
  const after = f.registry.management.createRecoveryCode("admin");
  f.registry.management.recover("admin", after.recoveryCode, childToken);
  expect(f.registry.authenticate(`Bearer ${rootToken}`)).toBeUndefined();
  expect(f.registry.authenticate(`Bearer ${childToken}`)?.serverAdmin).toBe(true);
});
