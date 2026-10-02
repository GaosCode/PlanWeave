import * as fs from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createFileOAuthClientStore,
  createMemoryOAuthClientStore,
  type RegisteredClient
} from "../oauthClientStore.js";
import { createPlanweaveMcpHttpServer } from "../server.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, writeFile: vi.fn(actual.writeFile), rename: vi.fn(actual.rename) };
});
const actual = await vi.importActual<typeof fs>("node:fs/promises");
let root: string;
let path: string;
let server: Server | undefined;
const old: RegisteredClient = {
  clientId: "client-a",
  clientIdIssuedAt: 1700000000,
  clientName: "committed",
  redirectUris: ["https://chatgpt.com/connector/oauth/callback"]
};

beforeEach(async () => {
  vi.mocked(fs.writeFile).mockReset().mockImplementation(actual.writeFile);
  vi.mocked(fs.rename).mockReset().mockImplementation(actual.rename);
  root = await actual.mkdtemp(join(tmpdir(), "planweave-client-commit-"));
  path = join(root, "oauth", "clients.json");
});
afterEach(async () => {
  await closeServer();
  await actual.rm(root, { recursive: true, force: true });
});

function ioFailure() {
  return Object.assign(new Error("client persistence failed"), { code: "EIO" });
}
function failOnce(stage: "write" | "rename") {
  if (stage === "write") {
    vi.mocked(fs.writeFile).mockImplementationOnce(async (target, _data, options) => {
      // A partial private temp file is real IO; the writer must clean it on rejection.
      await actual.writeFile(target, "partial", options);
      throw ioFailure();
    });
  } else vi.mocked(fs.rename).mockRejectedValueOnce(ioFailure());
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const stage of ["write", "rename"] as const) {
  it.each([
    "new",
    "replacement"
  ] as const)(`keeps committed ${stage} failure isolated for a %s client and later successful writes`, async (kind) => {
    const store = createFileOAuthClientStore(path);
    await store.set(old);
    const committed = await actual.readFile(path);
    const candidate = {
      ...old,
      clientId: kind === "new" ? "client-new" : old.clientId,
      clientName: "uncommitted"
    };
    failOnce(stage);
    await expect(store.set(candidate)).rejects.toThrow("client persistence failed");
    expect(await store.get(old.clientId)).toEqual(old);
    if (kind === "new") expect(await store.get(candidate.clientId)).toBeUndefined();
    expect(await actual.readFile(path)).toEqual(committed);
    expect(await actual.readdir(dirname(path))).toEqual(["clients.json"]);

    const next = { ...old, clientId: "client-z", clientName: "next committed" };
    await store.set(next);
    const document: unknown = JSON.parse(await actual.readFile(path, "utf8"));
    expect(document).toEqual({ version: 1, clients: [old, next] });
    const reopened = createFileOAuthClientStore(path);
    expect(await reopened.get(old.clientId)).toEqual(old);
    expect(await reopened.get(next.clientId)).toEqual(next);
    if (kind === "new") expect(await reopened.get(candidate.clientId)).toBeUndefined();
    if (process.platform !== "win32") {
      expect((await actual.stat(path)).mode & 0o777).toBe(0o600);
      expect((await actual.stat(dirname(path))).mode & 0o777).toBe(0o700);
    }
  });
}

it.each([
  "success",
  "failure"
] as const)("makes get wait for a pending %s rename and observe only its committed result", async (outcome) => {
  const store = createFileOAuthClientStore(path);
  await store.set(old);
  const entered = deferred(),
    release = deferred();
  vi.mocked(fs.rename).mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    if (outcome === "failure") throw ioFailure();
    return actual.rename(...args);
  });
  const candidate = { ...old, clientName: "new committed" };
  const writing = store.set(candidate);
  const observed = writing.then(
    () => "success",
    () => "failure"
  );
  await entered.promise;
  let readSettled = false;
  const reading = store.get(old.clientId).then((client) => {
    readSettled = true;
    return client;
  });
  await Promise.resolve();
  await Promise.resolve();
  try {
    expect(readSettled).toBe(false);
    expect(await createFileOAuthClientStore(path).get(old.clientId)).toEqual(old);
  } finally {
    release.resolve();
    await observed;
  }
  expect(await observed).toBe(outcome);
  expect(await reading).toEqual(outcome === "success" ? candidate : old);
});

it("serializes concurrent sets and a subsequent get without persisting a failed candidate", async () => {
  const store = createFileOAuthClientStore(path);
  await store.set(old);
  const entered = deferred(),
    release = deferred();
  vi.mocked(fs.rename).mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    throw ioFailure();
  });
  const failed = store.set({ ...old, clientId: "client-failed" });
  const rejected = expect(failed).rejects.toThrow("client persistence failed");
  await entered.promise;
  const next = { ...old, clientId: "client-b" };
  const successful = store.set(next);
  await Promise.resolve();
  const reading = store.get(next.clientId);
  release.resolve();
  await rejected;
  await successful;
  expect(await reading).toEqual(next);
  expect(await store.get("client-failed")).toBeUndefined();
  expect(JSON.parse(await actual.readFile(path, "utf8"))).toEqual({
    version: 1,
    clients: [old, next]
  });
  expect(await createFileOAuthClientStore(path).get("client-failed")).toBeUndefined();
});

async function closeServer() {
  if (!server) return;
  const active = server;
  server = undefined;
  await new Promise<void>((resolve, reject) =>
    active.close((error) => (error ? reject(error) : resolve()))
  );
}
async function startServer() {
  server = createPlanweaveMcpHttpServer({
    host: "127.0.0.1",
    port: 0,
    maxRequestBodyBytes: 1048576,
    planweaveHomeFromEnv: true,
    trustForwardedHeaders: false,
    oauth: { enabled: true, clientStorePath: path, tokenStorePath: join(root, "tokens.json") }
  });
  const active = server;
  await new Promise<void>((resolve, reject) => {
    active.once("error", reject);
    active.listen(0, "127.0.0.1", () => {
      active.off("error", reject);
      resolve();
    });
  });
  const address = active.address();
  if (!address || typeof address === "string") throw new Error("Expected loopback HTTP address");
  return `http://127.0.0.1:${address.port}`;
}

it("does not leak a failed HTTP registration into the next registration or reopen", async () => {
  const base = await startServer();
  const register = () =>
    fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "HTTP client", redirect_uris: old.redirectUris })
    });
  failOnce("write");
  const failed = await register();
  expect(failed.status).toBe(500);
  await failed.text();
  await expect(actual.stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  const success = await register();
  expect(success.status).toBe(201);
  const body: unknown = await success.json();
  if (
    !body ||
    typeof body !== "object" ||
    !("client_id" in body) ||
    typeof body.client_id !== "string"
  )
    throw new Error("Invalid registration response");
  const document: unknown = JSON.parse(await actual.readFile(path, "utf8"));
  expect(document).toEqual({
    version: 1,
    clients: [expect.objectContaining({ clientId: body.client_id, clientName: "HTTP client" })]
  });
  expect(await createFileOAuthClientStore(path).get(body.client_id)).toMatchObject({
    clientName: "HTTP client"
  });
});

it("retries failed recovered-client authorization with a new consent and persists before redirect", async () => {
  const base = await startServer();
  const clientId = "planweave_0123456789abcdef";
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: old.redirectUris[0],
    code_challenge: "challenge",
    code_challenge_method: "S256",
    scope: "planweave:mcp",
    resource: `${base}/mcp`
  });
  async function confirm() {
    const page = await fetch(`${base}/oauth/authorize?${params}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    const nonce = /name="csrf_nonce" value="([^"]+)"/.exec(html)?.[1];
    if (!nonce) throw new Error("Consent response omitted nonce");
    return fetch(`${base}/oauth/authorize/confirm`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...Object.fromEntries(params), csrf_nonce: nonce })
    });
  }
  failOnce("rename");
  const failed = await confirm();
  expect(failed.status).toBe(500);
  await failed.text();
  await expect(actual.stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  const retry = await confirm();
  expect(retry.status).toBe(302);
  expect(retry.headers.get("location")).toContain("code=");
  await retry.text();
  expect(await createFileOAuthClientStore(path).get(clientId)).toMatchObject({
    redirectUris: old.redirectUris
  });
  await closeServer();
  const reopenedBase = await startServer();
  const nextPage = await fetch(
    `${reopenedBase}/oauth/authorize?${new URLSearchParams({ ...Object.fromEntries(params), resource: `${reopenedBase}/mcp` })}`
  );
  expect(nextPage.status).toBe(200);
  await nextPage.text();
});

it("preserves the immediate memory store replacement contract", async () => {
  const store = createMemoryOAuthClientStore();
  await store.set(old);
  const replacement = { ...old, clientName: "memory replacement" };
  await store.set(replacement);
  expect(await store.get(old.clientId)).toEqual(replacement);
  expect(await store.get("missing")).toBeUndefined();
});
