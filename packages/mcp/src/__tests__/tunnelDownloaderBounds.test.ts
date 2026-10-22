import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile, rename } from "node:fs/promises";
import { createServer } from "node:http";
import { Worker } from "node:worker_threads";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { afterEach, expect, it, vi } from "vitest";
import { downloadOfficialTunnelClient, tunnelClientPlatformAsset } from "../tunnel/downloader.js";

const limits = vi.hoisted(() => ({
  deadlineMs: 1000,
  metadataBytes: 2048,
  checksumBytes: 128,
  zipBytes: 4096,
  binaryBytes: 1024,
  entries: 4
}));
vi.mock("../tunnel/downloadPolicy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tunnel/downloadPolicy.js")>()),
  tunnelDownloadLimits: limits
}));
const workerEvents = vi.hoisted(() => ({ started: undefined as (() => void) | undefined }));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(...args: ConstructorParameters<typeof actual.Worker>) {
        super(...args);
        workerEvents.started?.();
      }
    }
  };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile), rename: vi.fn(actual.rename) };
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  workerEvents.started = undefined;
});

function fixture(
  zip = zipSync({
    [tunnelClientPlatformAsset().binaryName]: new TextEncoder().encode("new-binary")
  })
) {
  const assetName = `tunnel-client-v-test-${tunnelClientPlatformAsset().assetSuffix}`;
  const metadata = JSON.stringify({
    tag_name: "v-test",
    assets: [
      { name: "SHA256SUMS.txt", browser_download_url: "https://fixture.test/sums" },
      { name: assetName, browser_download_url: "https://fixture.test/zip" }
    ]
  });
  const sums = `${createHash("sha256").update(zip).digest("hex")}  ${assetName}`;
  return { zip, metadata, sums };
}
function transport(
  data: ReturnType<typeof fixture>,
  change?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url: string, init?: RequestInit) =>
        (await change?.(url, init)) ??
        new Response(
          url.endsWith("/sums") ? data.sums : url.endsWith("/zip") ? data.zip : data.metadata
        )
    )
  );
}

it("rejects metadata by consumed bytes, preserves an old install and allows retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "tunnel-bounds-"));
  const data = fixture();
  transport(data);
  const previous = await downloadOfficialTunnelClient(root);
  const verification = JSON.stringify(previous.verification);
  const saved = join(root, "verification.json");
  await writeFile(saved, verification);
  transport(data, (url) =>
    new URL(url).hostname === "api.github.com"
      ? new Response(" ".repeat(4096) + data.metadata, { headers: { "content-length": "1" } })
      : undefined
  );
  await expect(downloadOfficialTunnelClient(root)).rejects.toThrow(/limit/i);
  expect(await readFile(previous.binaryPath, "utf8")).toBe("new-binary");
  expect(await readFile(saved, "utf8")).toBe(verification);
  transport(data);
  await expect(downloadOfficialTunnelClient(root)).resolves.toMatchObject({
    verification: previous.verification
  });
});

async function oldInstall() {
  const root = await mkdtemp(join(tmpdir(), "tunnel-bounds-"));
  transport(fixture());
  const previous = await downloadOfficialTunnelClient(root);
  const saved = join(root, "verification.json");
  await writeFile(saved, JSON.stringify(previous.verification));
  return { root, previous, saved };
}
async function preservedAndRetry(installed: Awaited<ReturnType<typeof oldInstall>>) {
  expect(await readFile(installed.previous.binaryPath, "utf8")).toBe("new-binary");
  expect(JSON.parse(await readFile(installed.saved, "utf8"))).toEqual(
    installed.previous.verification
  );
  transport(fixture());
  const next = await downloadOfficialTunnelClient(installed.root);
  expect(next.binaryPath).not.toBe(installed.previous.binaryPath);
  expect(await readFile(next.binaryPath, "utf8")).toBe("new-binary");
}

it.each([
  "headers",
  "metadata body",
  "checksum body",
  "archive body"
])("settles and aborts stalled %s under the one operation deadline", async (stage) => {
  const installed = await oldInstall();
  const data = fixture();
  let signal: AbortSignal | undefined;
  const cancel = vi.fn();
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  transport(data, (url, init) => {
    const matches =
      stage === "headers" ||
      (stage === "metadata body" && new URL(url).hostname === "api.github.com") ||
      (stage === "checksum body" && url.endsWith("/sums")) ||
      (stage === "archive body" && url.endsWith("/zip"));
    if (!matches) return undefined;
    signal = init?.signal ?? undefined;
    entered();
    if (stage === "headers") return new Promise<Response>(() => undefined);
    return new Response(new ReadableStream<Uint8Array>({ cancel }));
  });
  vi.useFakeTimers();
  try {
    const download = downloadOfficialTunnelClient(installed.root);
    const rejection = expect(download).rejects.toThrow(/deadline/);
    await ready;
    await vi.advanceTimersByTimeAsync(limits.deadlineMs);
    await rejection;
    expect(signal?.aborted).toBe(true);
    if (stage !== "headers") expect(cancel).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
  await preservedAndRetry(installed);
});

it.each([
  ["metadata", (url: URL) => url.hostname === "api.github.com", "metadataBytes"],
  ["checksum", (url: URL) => url.pathname === "/sums", "checksumBytes"],
  ["archive", (url: URL) => url.pathname === "/zip", "zipBytes"]
] as const)("bounds chunked %s without trusting Content-Length and cancels readers", async (_label, match, key) => {
  const installed = await oldInstall();
  const cancel = vi.fn();
  let signal: AbortSignal | undefined;
  transport(fixture(), (url, init) => {
    if (!match(new URL(url))) return undefined;
    signal = init?.signal ?? undefined;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(limits[key]));
          controller.enqueue(new Uint8Array(1));
        },
        cancel
      })
    );
  });
  await expect(downloadOfficialTunnelClient(installed.root)).rejects.toThrow(/byte limit/);
  expect(signal?.aborted).toBe(true);
  expect(cancel).toHaveBeenCalledOnce();
  await preservedAndRetry(installed);
});

it("aborts and cancels the parallel archive reader when checksums exceed their limit", async () => {
  const installed = await oldInstall();
  const cancel = vi.fn();
  let archiveSignal: AbortSignal | undefined;
  transport(fixture(), (url, init) => {
    if (url.endsWith("/sums")) return new Response(new Uint8Array(limits.checksumBytes + 1));
    if (url.endsWith("/zip")) {
      archiveSignal = init?.signal ?? undefined;
      return new Response(new ReadableStream<Uint8Array>({ cancel }));
    }
    return undefined;
  });
  await expect(downloadOfficialTunnelClient(installed.root)).rejects.toThrow(/checksum.*limit/);
  expect(archiveSignal?.aborted).toBe(true);
  expect(cancel).toHaveBeenCalledOnce();
  await preservedAndRetry(installed);
});

function changedZip(kind: string): Uint8Array {
  const target = tunnelClientPlatformAsset().binaryName;
  if (kind === "missing") return zipSync({ other: new Uint8Array([1]) });
  if (kind === "duplicate")
    return zipSync({ [target]: new Uint8Array([1]), [`dir/${target}`]: new Uint8Array([2]) });
  if (kind === "entries")
    return zipSync(
      Object.fromEntries([target, "a", "b", "c", "d"].map((name) => [name, new Uint8Array([1])]))
    );
  if (kind === "declared") return zipSync({ [target]: new Uint8Array(limits.binaryBytes + 1) });
  const zip = zipSync({ [target]: new Uint8Array(512) });
  if (kind === "truncated") return zip.subarray(0, zip.length - 10);
  const view = new DataView(zip.buffer);
  const end = zip.length - 22;
  const central = view.getUint32(end + 16, true);
  if (kind === "actual") {
    view.setUint32(22, 1, true);
    view.setUint32(central + 24, 1, true);
  } else if (kind === "invalid-size") view.setUint32(central + 20, 0xffffffff, true);
  else if (kind === "crc") view.setUint32(central + 16, 123, true);
  return zip;
}
it.each([
  "missing",
  "duplicate",
  "entries",
  "declared",
  "truncated",
  "actual",
  "invalid-size",
  "crc"
])("rejects signed malformed ZIP (%s), preserves install, and permits retry", async (kind) => {
  const installed = await oldInstall();
  transport(fixture(changedZip(kind)));
  await expect(downloadOfficialTunnelClient(installed.root)).rejects.toThrow(/archive|ZIP|binary/);
  await preservedAndRetry(installed);
});

it("checks the SHA before accepting or decoding a malformed archive", async () => {
  const installed = await oldInstall();
  const data = fixture(new Uint8Array([1, 2, 3]));
  transport(data, (url) =>
    url.endsWith("/sums")
      ? new Response(
          `${"0".repeat(64)}  tunnel-client-v-test-${tunnelClientPlatformAsset().assetSuffix}`
        )
      : undefined
  );
  await expect(downloadOfficialTunnelClient(installed.root)).rejects.toThrow(
    /checksum does not match/
  );
  await preservedAndRetry(installed);
});

it("terminates the active archive worker at the original deadline before any install write", async () => {
  const installed = await oldInstall();
  transport(fixture());
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  workerEvents.started = started;
  const terminate = vi.spyOn(Worker.prototype, "terminate");
  vi.mocked(writeFile).mockClear();
  vi.useFakeTimers();
  try {
    const download = downloadOfficialTunnelClient(installed.root);
    const rejection = expect(download).rejects.toThrow(/deadline/);
    await ready;
    await vi.advanceTimersByTimeAsync(limits.deadlineMs);
    await rejection;
    expect(terminate).toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
    workerEvents.started = undefined;
  }
  await preservedAndRetry(installed);
});

it.each([
  "write",
  "rename"
])("preserves the old install and removes only staging on install %s failure", async (kind) => {
  const installed = await oldInstall();
  transport(fixture());
  const failure = new Error(`${kind} denied`);
  if (kind === "write") vi.mocked(writeFile).mockRejectedValueOnce(failure);
  else vi.mocked(rename).mockRejectedValueOnce(failure);
  await expect(downloadOfficialTunnelClient(installed.root)).rejects.toBe(failure);
  const parent = join(installed.root, "tunnel-client", "v-test");
  expect(await readdir(parent)).toEqual([installed.previous.binaryPath.split("/").at(-2)]);
  await preservedAndRetry(installed);
});

it("uses one remaining deadline across metadata and archive work", async () => {
  const installed = await oldInstall();
  const data = fixture();
  let releaseMetadata!: (response: Response) => void;
  let archiveStarted!: () => void;
  const archiveReady = new Promise<void>((resolve) => {
    archiveStarted = resolve;
  });
  const cancelled = vi.fn();
  transport(data, (url) => {
    if (new URL(url).hostname === "api.github.com")
      return new Promise<Response>((resolve) => {
        releaseMetadata = resolve;
      });
    if (url.endsWith("/zip")) {
      archiveStarted();
      return new Response(new ReadableStream<Uint8Array>({ cancel: cancelled }));
    }
    return undefined;
  });
  vi.useFakeTimers();
  try {
    const download = downloadOfficialTunnelClient(installed.root);
    const rejection = expect(download).rejects.toThrow(/deadline/);
    await vi.advanceTimersByTimeAsync(limits.deadlineMs - 1);
    releaseMetadata(new Response(data.metadata));
    await archiveReady;
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(cancelled).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
  await preservedAndRetry(installed);
});

it("downloads through real HTTP streaming and cancels an unbounded archive connection", async () => {
  const installed = await oldInstall();
  const data = fixture();
  const nativeFetch = globalThis.fetch;
  vi.unstubAllGlobals();
  const fetchHttp = globalThis.fetch;
  let closed!: () => void;
  const connectionClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const server = createServer((request, response) => {
    if (request.url === "/zip") {
      response.writeHead(200);
      response.write(new Uint8Array(limits.zipBytes));
      response.write(new Uint8Array(1));
      response.on("close", closed);
    } else response.end(data.sums);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP test address");
  const origin = `http://127.0.0.1:${address.port}`;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (new URL(url).hostname === "api.github.com") return new Response(data.metadata);
    return fetchHttp(`${origin}${new URL(url).pathname}`, init);
  });
  try {
    await expect(downloadOfficialTunnelClient(installed.root)).rejects.toThrow(
      /archive.*byte limit/
    );
    await connectionClosed;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    vi.stubGlobal("fetch", nativeFetch);
  }
  await preservedAndRetry(installed);
});

it("extracts only the target without expanding a large unrelated entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "tunnel-target-only-"));
  const target = tunnelClientPlatformAsset().binaryName;
  transport(
    fixture(
      zipSync({
        unrelated: new Uint8Array(1024 * 1024),
        [target]: new TextEncoder().encode("target-only")
      })
    )
  );
  const result = await downloadOfficialTunnelClient(root);
  expect(await readFile(result.binaryPath, "utf8")).toBe("target-only");
});

it("selects the official client asset when same-platform runtime assets come first", async () => {
  const root = await mkdtemp(join(tmpdir(), "tunnel-asset-identity-"));
  const data = fixture();
  const metadata = JSON.parse(data.metadata);
  metadata.assets.unshift({
    name: `tunnel-client-runtime-cloudflared-v-test-${tunnelClientPlatformAsset().assetSuffix}`,
    browser_download_url: "https://fixture.test/wrong"
  });
  transport({ ...data, metadata: JSON.stringify(metadata) });
  const result = await downloadOfficialTunnelClient(root);
  expect(await readFile(result.binaryPath, "utf8")).toBe("new-binary");
});

it.each([
  "missing",
  "duplicate client",
  "duplicate checksum"
])("rejects ambiguous release identity (%s) without replacing an install", async (kind) => {
  const installed = await oldInstall();
  const data = fixture();
  const metadata = JSON.parse(data.metadata);
  if (kind === "missing") metadata.assets.pop();
  else metadata.assets.push(metadata.assets[kind === "duplicate client" ? 1 : 0]);
  transport({ ...data, metadata: JSON.stringify(metadata) });
  await expect(downloadOfficialTunnelClient(installed.root)).rejects.toThrow(/exactly one/);
  await preservedAndRetry(installed);
});

it("does not promote or leave background writes when installation consumes the deadline", async () => {
  const installed = await oldInstall();
  transport(fixture());
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let entered!: () => void, release!: () => void;
  const writeStarted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const writable = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
    entered();
    await writable;
    return actual.writeFile(...args);
  });
  const promote = vi.mocked(rename);
  promote.mockClear();
  const download = downloadOfficialTunnelClient(installed.root);
  const rejection = expect(download).rejects.toThrow(/deadline|aborted/);
  await writeStarted;
  // The operation owns the real pending write; moving the clock makes its next check expire.
  vi.spyOn(performance, "now").mockReturnValue(Number.MAX_SAFE_INTEGER);
  release();
  await rejection;
  expect(promote).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  const parent = join(installed.root, "tunnel-client", "v-test");
  expect(await readdir(parent)).toEqual([installed.previous.binaryPath.split("/").at(-2)]);
  await preservedAndRetry(installed);
});

it("releases a body reader even when transport cancellation cleanup never settles", async () => {
  const installed = await oldInstall();
  const cancel = vi.fn(() => new Promise<void>(() => undefined));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(limits.checksumBytes + 1));
    },
    cancel
  });
  transport(fixture(), (url) => (url.endsWith("/sums") ? new Response(stream) : undefined));
  await expect(downloadOfficialTunnelClient(installed.root)).rejects.toThrow(/checksum.*limit/);
  expect(cancel).toHaveBeenCalledOnce();
  expect(stream.locked).toBe(false);
  await preservedAndRetry(installed);
});

it("preserves HTTP rate-limit diagnostics without waiting for a failed response cleanup", async () => {
  const installed = await oldInstall();
  const cancel = vi.fn(() => new Promise<void>(() => undefined));
  transport(fixture(), (url) =>
    new URL(url).hostname === "api.github.com"
      ? new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 403 })
      : undefined
  );
  await expect(downloadOfficialTunnelClient(installed.root)).rejects.toThrow(
    /GitHub API rate limit/
  );
  expect(cancel).toHaveBeenCalledOnce();
  await preservedAndRetry(installed);
});

it("reports the authoritative deadline when native writeFile rejects its aborted signal", async () => {
  const installed = await oldInstall();
  transport(fixture());
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let entered!: () => void;
  const writeStarted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let nativeError: unknown;
  vi.mocked(writeFile).mockClear();
  vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
    const options = args[2];
    if (!options || typeof options !== "object" || !options.signal) {
      throw new Error("Installation write must have its operation signal.");
    }
    const signal = options.signal;
    entered();
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true })
    );
    try {
      await actual.writeFile(...args);
    } catch (error) {
      nativeError = error;
      throw error;
    }
  });
  vi.mocked(rename).mockClear();
  vi.useFakeTimers();
  try {
    const download = downloadOfficialTunnelClient(installed.root);
    const rejection = expect(download).rejects.toMatchObject({
      code: "timeout",
      message: expect.stringContaining("operation deadline")
    });
    await writeStarted;
    await vi.advanceTimersByTimeAsync(limits.deadlineMs);
    await rejection;
    expect(nativeError).toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
    expect(writeFile).toHaveBeenCalledOnce();
    expect(rename).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
  const parent = join(installed.root, "tunnel-client", "v-test");
  expect(await readdir(parent)).toEqual([installed.previous.binaryPath.split("/").at(-2)]);
  await preservedAndRetry(installed);
});
