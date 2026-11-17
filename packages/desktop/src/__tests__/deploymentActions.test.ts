import { spawnSync } from "node:child_process";
import { createCipheriv } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  truncate,
  unlink,
  writeFile
} from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WindowsPrivateStorageSecurity } from "@planweave-ai/agent-host";
import {
  hashOperatorToken,
  parseServerConfig,
  restoreServerDataScript
} from "@planweave-ai/server";
import { unzipSync } from "fflate";
import { build, type BuildOptions } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DeploymentActions,
  DeploymentBundleUnavailableError
} from "../main/collaboration/deploymentActions.js";
import { writeDesktopConnectionScript } from "../main/collaboration/writeDesktopConnectionScript.js";
import { deploymentArchiveFailureCodes } from "../shared/deploymentArchiveFailureCodes.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    open: vi.fn(actual.open),
    rename: vi.fn(actual.rename),
    rmdir: vi.fn(actual.rmdir),
    unlink: vi.fn(actual.unlink)
  };
});

const operatorToken = `pw_operator_${"A".repeat(43)}`;

const target = {
  schemaVersion: "deployment-target-draft/v1" as const,
  displayName: "Self-hosted Server",
  endpoint: {
    topology: "public_https" as const,
    serverOrigin: "https://collab.example.test/",
    allowedClientOrigins: ["https://collab.example.test/"],
    tlsTrust: "system_ca" as const
  },
  capabilities: ["deployment_guidance", "connectivity_validation"]
};

const roots: string[] = [];
let workerBuildRoot: string;
let archiveWorkerEntry: URL;

beforeAll(async () => {
  const {
    electronBuildOptions
  }: {
    electronBuildOptions: () => { deploymentArchiveWorker: BuildOptions };
  } = await import(new URL("../../scripts/electron-build.mjs", import.meta.url).href);
  workerBuildRoot = await mkdtemp(join(tmpdir(), "planweave-deployment-worker-"));
  const worker = electronBuildOptions().deploymentArchiveWorker;
  const outfile = join(workerBuildRoot, "deploymentArchiveWorker.cjs");
  await build({ ...worker, outfile, sourcemap: false, logLevel: "silent" });
  archiveWorkerEntry = pathToFileURL(outfile);
});

afterAll(async () => {
  if (workerBuildRoot) await rm(workerBuildRoot, { recursive: true, force: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function request(
  action:
    | "request_deployment_guidance"
    | "copy_supported_compose_handoff"
    | "export_supported_compose_bundle"
    | "validate_connectivity"
) {
  return { action, target };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "planweave-deployment-actions-"));
  roots.push(root);
  return root;
}

async function exportFixture(token = operatorToken, credential = token) {
  const root = await temporaryRoot();
  const resourceDirectory = join(root, "resource");
  const bundlePath = join(root, "bundle.zip");
  await mkdir(join(resourceDirectory, "image"), { recursive: true });
  await Promise.all([
    writeFile(join(resourceDirectory, "compose.yaml"), "services: {}\n"),
    writeFile(join(resourceDirectory, "image", "Dockerfile"), "FROM scratch\n")
  ]);
  const source = {
    operatorToken: token,
    config: parseServerConfig({
      version: "server-config/v1",
      bind: { host: "0.0.0.0", port: 443 },
      publicUrl: target.endpoint.serverOrigin,
      deployment: target.endpoint,
      tls: {
        certificatePath: "/run/planweave/input/tls/server.crt",
        privateKeyPath: "/run/planweave/input/tls/server.key"
      },
      dataDirectory: "/var/lib/planweave-server",
      trustedProjects: [],
      operatorCredentials: [
        {
          operatorId: "operator-test",
          tokenSha256: hashOperatorToken(credential),
          projectIds: [],
          serverAdmin: true
        }
      ]
    })
  };
  const actions = (
    showSaveDialog = async () => ({ canceled: false, filePath: bundlePath }),
    workerEntry = archiveWorkerEntry
  ) =>
    new DeploymentActions({
      resourceDirectory,
      archiveWorkerEntry: workerEntry,
      resolveBundleSource: async () => source,
      showSaveDialog
    });
  return {
    root,
    resourceDirectory,
    bundlePath,
    actions,
    exportBundle: (destination = bundlePath) =>
      actions(async () => ({ canceled: false, filePath: destination })).exportComposeBundle(
        request("export_supported_compose_bundle")
      )
  };
}

const oldBundle = Buffer.from("previous deployment archive\n");
const otherToken = `pw_operator_${"B".repeat(43)}`;

async function archiveWorkerWithFileSystem(root: string, source: string): Promise<URL> {
  const entry = join(root, "archive-fixture-worker.cjs");
  await writeFile(
    entry,
    `${source}\nrequire(${JSON.stringify(fileURLToPath(archiveWorkerEntry))});\n`
  );
  return pathToFileURL(entry);
}

const fsFailure = (code: string) => Object.assign(new Error(code), { code });

function failStagedWrite(stage: "write" | "sync" | "rename") {
  const failure = fsFailure(stage === "write" ? "ENOSPC" : "EIO");
  if (stage === "rename") {
    vi.mocked(rename).mockRejectedValueOnce(failure);
    return failure;
  }
  vi.mocked(open).mockImplementationOnce(async (...args) => {
    const actual = await vi.importActual<typeof fs>("node:fs/promises");
    const handle = await actual.open(...args);
    if (stage === "write") {
      const write = handle.writeFile.bind(handle);
      vi.spyOn(handle, "writeFile").mockImplementationOnce(async () => {
        await write(Buffer.from("partial write\n"));
        throw failure;
      });
    } else {
      vi.spyOn(handle, "sync").mockRejectedValueOnce(failure);
    }
    return handle;
  });
  return failure;
}

describe("DeploymentActions", () => {
  it("generates and copies only the fixed supported Compose handoff", () => {
    const copied: string[] = [];
    const actions = new DeploymentActions({
      writeClipboard: (value) => copied.push(value),
      now: () => new Date("2030-01-01T00:00:00.000Z")
    });
    const guidance = actions.guidance(request("request_deployment_guidance"));
    expect(guidance.handoff.preview).toContain("--detach --wait");
    expect(guidance.handoff.projectsMountTarget).toBe("/var/lib/planweave/projects");
    expect(actions.copyComposeHandoff(request("copy_supported_compose_handoff"))).toEqual({
      state: "copied",
      copiedAt: "2030-01-01T00:00:00.000Z"
    });
    expect(copied).toEqual([guidance.handoff.preview]);
  });

  it("keeps loopback out of direct-TLS handoff without rejecting generic private HTTPS", () => {
    const actions = new DeploymentActions();
    const loopback = {
      ...target,
      endpoint: {
        topology: "loopback_http" as const,
        serverOrigin: "http://127.0.0.1:7443/",
        allowedClientOrigins: ["http://127.0.0.1:7443/"],
        tlsTrust: "not_applicable" as const
      }
    };
    expect(
      actions.guidance({
        action: "request_deployment_guidance",
        target: loopback
      }).handoff.state
    ).toBe("not_applicable");
    expect(() =>
      actions.copyComposeHandoff({
        action: "copy_supported_compose_handoff",
        target: loopback
      })
    ).toThrow("deployment_compose_handoff_not_supported");
    const privateHttps = {
      ...target,
      endpoint: {
        topology: "private_https" as const,
        serverOrigin: "https://planweave.tailnet.ts.net/",
        allowedClientOrigins: ["https://planweave.tailnet.ts.net/"],
        tlsTrust: "system_ca" as const
      }
    };
    expect(
      actions.guidance({
        action: "request_deployment_guidance",
        target: privateHttps
      }).handoff.state
    ).toBe("supported");
  });

  it("reports static origin configuration failures without claiming a WebSocket probe", async () => {
    const actions = new DeploymentActions({
      request: async () => new Response(null, { status: 200 })
    });
    const mismatched = {
      ...target,
      endpoint: { ...target.endpoint, allowedClientOrigins: ["https://desktop.example.test/"] }
    };
    await expect(
      actions.validateConnectivity({
        action: "validate_connectivity",
        target: mismatched
      })
    ).resolves.toMatchObject({
      status: "invalid_origin",
      failureCode: "allowed_client_origin_missing"
    });
  });

  it("does not provision a deployment source when export is cancelled", async () => {
    const resolveBundleSource = vi.fn();
    const actions = new DeploymentActions({
      resourceDirectory: "/unused",
      resolveBundleSource,
      showSaveDialog: async () => ({ canceled: true })
    });
    await expect(
      actions.exportComposeBundle(request("export_supported_compose_bundle"))
    ).resolves.toMatchObject({
      state: "cancelled"
    });
    expect(resolveBundleSource).not.toHaveBeenCalled();
  });

  it("rejects a second request while an export is active and admits the next one after it settles", async () => {
    const fixture = await exportFixture();
    const pendingDialog = Promise.withResolvers<{ canceled: boolean; filePath: string }>();
    const save = { canceled: false, filePath: fixture.bundlePath };
    const showSaveDialog = vi
      .fn()
      .mockReturnValueOnce(pendingDialog.promise)
      .mockResolvedValue(save);
    const actions = fixture.actions(showSaveDialog);
    const input = request("export_supported_compose_bundle");
    const first = actions.exportComposeBundle(input);
    const second = actions.exportComposeBundle(input);
    pendingDialog.resolve(save);
    const results = await Promise.allSettled([first, second]);

    expect(results).toMatchObject([
      { status: "fulfilled", value: { state: "exported" } },
      { status: "rejected", reason: { code: "deployment_archive_export_in_progress" } }
    ]);
    expect(showSaveDialog).toHaveBeenCalledTimes(1);
    await expect(actions.exportComposeBundle(input)).resolves.toMatchObject({ state: "exported" });
    expect(showSaveDialog).toHaveBeenCalledTimes(2);
  });

  it("returns only explicit deployment unavailability and surfaces credential failures", async () => {
    const unavailable = new DeploymentActions({
      resourceDirectory: "/unused",
      resolveBundleSource: async () => {
        throw new DeploymentBundleUnavailableError("needs_project", "selection_missing");
      },
      showSaveDialog: async () => ({ canceled: false, filePath: "/tmp/bundle.zip" })
    });
    await expect(
      unavailable.exportComposeBundle(request("export_supported_compose_bundle"))
    ).resolves.toMatchObject({
      state: "needs_project"
    });

    const failing = new DeploymentActions({
      resourceDirectory: "/unused",
      resolveBundleSource: async () => {
        throw new Error("secure_storage_failed");
      },
      showSaveDialog: async () => ({ canceled: false, filePath: "/tmp/bundle.zip" })
    });
    await expect(
      failing.exportComposeBundle(request("export_supported_compose_bundle"))
    ).rejects.toThrow("secure_storage_failed");
  });

  it("exports a Server bundle without packing the current project", async () => {
    const { root, bundlePath, exportBundle } = await exportFixture();
    const exported = await exportBundle();
    expect(exported).toEqual({
      state: "exported",
      fileName: "bundle.zip",
      tls: "required_after_export"
    });
    expect(JSON.stringify(exported)).not.toContain(operatorToken);
    if (process.platform !== "win32") expect((await stat(bundlePath)).mode & 0o777).toBe(0o600);
    const archive = unzipSync(await readFile(bundlePath));
    expect(Object.keys(archive).sort()).toEqual(
      [
        ".operator-token",
        "compose.yaml",
        "image/Dockerfile",
        "restore-server-data.sh",
        "server.json",
        "tls/.gitkeep",
        "write-desktop-connection.sh"
      ].sort()
    );
    expect(new TextDecoder().decode(archive[".operator-token"])).toBe(`${operatorToken}\n`);
    const script = new TextDecoder().decode(archive["write-desktop-connection.sh"]);
    expect(script).toBe(
      writeDesktopConnectionScript.endsWith("\n")
        ? writeDesktopConnectionScript
        : `${writeDesktopConnectionScript}\n`
    );
    expect(script).toContain(".setup-handoff.txt");
    expect(JSON.parse(new TextDecoder().decode(archive["server.json"]))).toMatchObject({
      trustedProjects: []
    });
    expect(JSON.parse(new TextDecoder().decode(archive["server.json"]))).not.toMatchObject({
      operatorToken
    });
    const scriptPath = join(root, "write-desktop-connection.sh");
    await writeFile(scriptPath, script);
    expect(spawnSync("sh", ["-n", scriptPath], { encoding: "utf8" }).status).toBe(0);
    const restoreScript = new TextDecoder().decode(archive["restore-server-data.sh"]);
    expect(restoreScript).toBe(
      restoreServerDataScript.endsWith("\n")
        ? restoreServerDataScript
        : `${restoreServerDataScript}\n`
    );
    const restoreScriptPath = join(root, "restore-server-data.sh");
    await writeFile(restoreScriptPath, restoreScript);
    expect(spawnSync("sh", ["-n", restoreScriptPath], { encoding: "utf8" }).status).toBe(0);
  });

  it("stores incompressible resources and deflates resources with compressible regions", async () => {
    const { resourceDirectory, bundlePath, exportBundle } = await exportFixture();
    const incompressible = createCipheriv("aes-256-ctr", Buffer.alloc(32), Buffer.alloc(16)).update(
      Buffer.alloc(4 * 1024 * 1024)
    );
    const middleCompressible = Buffer.from(incompressible);
    middleCompressible.fill(
      65,
      Math.floor(incompressible.length * 0.275),
      Math.floor(incompressible.length * 0.365)
    );
    const lateCompressible = Buffer.from(incompressible);
    lateCompressible.fill(65, lateCompressible.length - 16 * 1024);
    const resources = [
      { name: "incompressible.bin", bytes: incompressible, compression: 0 },
      { name: "middle-compressible.bin", bytes: middleCompressible, compression: 8 },
      { name: "late-compressible.bin", bytes: lateCompressible, compression: 8 }
    ];
    for (const { name, bytes } of resources) {
      await writeFile(join(resourceDirectory, "image", name), bytes);
    }

    await expect(exportBundle()).resolves.toMatchObject({ state: "exported" });
    const compressionMethods = new Map<string, number>();
    const archive = unzipSync(await readFile(bundlePath), {
      filter: ({ name, compression }) => {
        compressionMethods.set(name, compression);
        return true;
      }
    });
    for (const { name, bytes, compression } of resources) {
      const entry = `image/${name}`;
      expect(compressionMethods.get(entry), entry).toBe(compression);
      expect(Buffer.from(archive[entry]).equals(bytes), entry).toBe(true);
    }
  });

  it("rejects a bundle whose operator token does not match server.json", async () => {
    const { root, bundlePath, exportBundle } = await exportFixture(otherToken, operatorToken);
    await writeFile(bundlePath, oldBundle);
    await expect(exportBundle()).resolves.toMatchObject({ state: "invalid_project" });
    expect(await readFile(bundlePath)).toEqual(oldBundle);
    expect((await readdir(root)).sort()).toEqual(["bundle.zip", "resource"]);
  });

  it.each([
    { name: "missing entry", code: deploymentArchiveFailureCodes.workerFailed },
    { name: "invalid Worker URL", code: deploymentArchiveFailureCodes.workerStartFailed },
    {
      name: "uncaught Worker error",
      source: 'throw new Error("controlled worker error");',
      code: deploymentArchiveFailureCodes.workerFailed
    },
    {
      name: "clean exit before a reply",
      source: "process.exit(0);",
      code: deploymentArchiveFailureCodes.workerExited
    },
    {
      name: "nonzero exit after a ready reply",
      source: 'parentPort.postMessage({ state: "ready", bytes }); process.exit(1);',
      code: deploymentArchiveFailureCodes.workerExited
    },
    {
      name: "duplicate ready replies",
      source: 'for (let i = 0; i < 2; i++) parentPort.postMessage({ state: "ready", bytes });',
      code: deploymentArchiveFailureCodes.workerProtocolInvalid
    },
    {
      name: "malformed reply",
      source: 'parentPort.postMessage({ state: "ready", bytes: new ArrayBuffer(0) });',
      code: deploymentArchiveFailureCodes.workerProtocolInvalid
    }
  ])("preserves a previous export after $name", async ({ name, source, code }) => {
    const { root, bundlePath, actions } = await exportFixture();
    const entry = join(root, "faulty-worker.cjs");
    if (source) {
      await writeFile(
        entry,
        `const { parentPort } = require("node:worker_threads");\nconst bytes = new ArrayBuffer(1);\n${source}\n`
      );
    }
    const archiveEntry =
      name === "invalid Worker URL"
        ? new URL("https://invalid.example.test/")
        : pathToFileURL(entry);
    await writeFile(bundlePath, oldBundle);
    await expect(
      actions(undefined, archiveEntry).exportComposeBundle(
        request("export_supported_compose_bundle")
      )
    ).rejects.toMatchObject({ code });
    expect(await readFile(bundlePath)).toEqual(oldBundle);
    expect((await readdir(root)).sort()).toEqual(
      source ? ["bundle.zip", "faulty-worker.cjs", "resource"] : ["bundle.zip", "resource"]
    );
  });

  it("terminates an active Worker on shutdown even after it replies ready", async () => {
    const { root, bundlePath, actions } = await exportFixture();
    const entry = join(root, "holding-worker.cjs");
    const ready = join(root, "worker-ready");
    await writeFile(bundlePath, oldBundle);
    await writeFile(
      entry,
      [
        'const { parentPort } = require("node:worker_threads");',
        'const { writeFileSync } = require("node:fs");',
        'parentPort.postMessage({ state: "ready", bytes: new ArrayBuffer(1) });',
        `writeFileSync(${JSON.stringify(ready)}, "ready");`,
        "setInterval(() => undefined, 1000);"
      ].join("\n")
    );
    const owner = actions(undefined, pathToFileURL(entry));
    const input = request("export_supported_compose_bundle");
    const outcome = expect(owner.exportComposeBundle(input)).rejects.toMatchObject({
      code: deploymentArchiveFailureCodes.shuttingDown
    });
    try {
      await vi.waitFor(async () => expect(await readFile(ready, "utf8")).toBe("ready"));
    } finally {
      await owner.shutdown();
    }
    await outcome;
    await expect(owner.exportComposeBundle(input)).rejects.toMatchObject({
      code: deploymentArchiveFailureCodes.shuttingDown
    });
    expect(await readFile(bundlePath)).toEqual(oldBundle);
    expect((await readdir(root)).sort()).toEqual([
      "bundle.zip",
      "holding-worker.cjs",
      "resource",
      "worker-ready"
    ]);
  });

  it.skipIf(process.platform === "win32").each([".", "compose.yaml", "image", "image/Dockerfile"])(
    "rejects a symbolic link used as an archive input at %s",
    async (relativePath) => {
      const { root, bundlePath, resourceDirectory, exportBundle } = await exportFixture();
      const entry = join(resourceDirectory, relativePath);
      const relocated = join(root, "relocated");
      await rename(entry, relocated);
      await symlink(relocated, entry);
      await writeFile(bundlePath, oldBundle);
      await expect(exportBundle()).resolves.toMatchObject({ state: "invalid_project" });
      expect(await readFile(bundlePath)).toEqual(oldBundle);
      expect((await readdir(root)).sort()).toEqual(["bundle.zip", "relocated", "resource"]);
    }
  );

  it("counts generated files and resources toward a single byte budget", async () => {
    const { root, bundlePath, resourceDirectory, exportBundle } = await exportFixture();
    await truncate(join(resourceDirectory, "image", "Dockerfile"), 256 * 1024 * 1024);
    await writeFile(bundlePath, oldBundle);
    await expect(exportBundle()).resolves.toMatchObject({ state: "invalid_project" });
    expect(await readFile(bundlePath)).toEqual(oldBundle);
    expect((await readdir(root)).sort()).toEqual(["bundle.zip", "resource"]);
  });

  it.each([
    ["resource root", ""],
    ["nested image directory", "image/nested"]
  ])("preserves a previous export when %s changes after discovery", async (_, subdirectory) => {
    const { root, bundlePath, resourceDirectory, actions } = await exportFixture();
    const affected = join(resourceDirectory, subdirectory);
    if (subdirectory) {
      await mkdir(affected);
      await writeFile(join(affected, "sample.txt"), "local fixture\n");
    }
    const timestamp = 946684800;
    const entry = await archiveWorkerWithFileSystem(
      root,
      `
const fs = require("node:fs");
const asyncFs = require("node:fs/promises");
const { workerData } = require("node:worker_threads");
const lstat = asyncFs.lstat;
const lstatSync = fs.lstatSync;
const affected = ${subdirectory ? `fs.realpathSync.native(${JSON.stringify(affected)})` : "workerData.resourceDirectory"};
let changed = false;
const observe = (path, metadata) => {
  if (!changed && path === affected) {
    changed = true;
    fs.utimesSync(path, ${timestamp}, ${timestamp});
  }
  return metadata;
};
fs.lstatSync = (path, ...args) => observe(path, lstatSync(path, ...args));
asyncFs.lstat = async (path, ...args) => observe(path, await lstat(path, ...args));
`
    );
    await writeFile(bundlePath, oldBundle);
    await expect(
      actions(undefined, entry).exportComposeBundle(request("export_supported_compose_bundle"))
    ).resolves.toMatchObject({ state: "invalid_project" });
    expect((await stat(affected)).mtimeMs).toBe(timestamp * 1000);
    expect(await readFile(bundlePath)).toEqual(oldBundle);
    expect((await readdir(root)).sort()).toEqual([
      "archive-fixture-worker.cjs",
      "bundle.zip",
      "resource"
    ]);
  });

  it("rejects an incomplete resource directory without creating an export", async () => {
    const { root, resourceDirectory, exportBundle } = await exportFixture();
    await rename(join(resourceDirectory, "image"), join(root, "incomplete-image"));
    await expect(exportBundle()).resolves.toMatchObject({ state: "invalid_project" });
    expect((await readdir(root)).sort()).toEqual(["incomplete-image", "resource"]);
  });

  it("exports the last representable ZIP entry and rejects one more before publishing", async () => {
    const { root, bundlePath, resourceDirectory, actions } = await exportFixture();
    const emptyFile = join(root, "empty.bin");
    const extraEntry = join(root, "append-entry");
    await writeFile(emptyFile, "");
    const entry = await archiveWorkerWithFileSystem(
      root,
      `
const fs = require("node:fs");
const { closeSync, existsSync, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync } = fs;
const { dirname, join, basename } = require("node:path");
const canonicalPath = realpathSync.native;
const image = canonicalPath(${JSON.stringify(join(resourceDirectory, "image"))});
const empty = ${JSON.stringify(emptyFile)};
const extra = existsSync(${JSON.stringify(extraEntry)});
const entries = Array.from({ length: 65535 - 6 + Number(extra) }, (_, n) => "resource-" + n);
const isVirtualFile = path => dirname(path) === image && basename(path).startsWith("resource-");
const virtualFd = -1;
const directorySnapshots = new Map([image, dirname(image)].map(path => [
  path, lstatSync(path, { bigint: true })
]));
const metadata = lstatSync(empty);
const bigintMetadata = lstatSync(empty, { bigint: true });
const fileStats = options => options?.bigint ? bigintMetadata : metadata;
fs.lstatSync = (path, options) => isVirtualFile(path) ? fileStats(options)
  : (options?.bigint ? directorySnapshots.get(path) : undefined) ?? lstatSync(path, options);
fs.openSync = (path, ...args) => isVirtualFile(path) ? virtualFd : openSync(path, ...args);
fs.fstatSync = (fd, options) => fd === virtualFd ? fileStats(options) : fstatSync(fd, options);
fs.readSync = (fd, ...args) => fd === virtualFd ? 0 : readSync(fd, ...args);
fs.closeSync = fd => fd === virtualFd ? undefined : closeSync(fd);
realpathSync.native = (path, ...args) => directorySnapshots.has(path) ? path : canonicalPath(path, ...args);
fs.opendirSync = (path, ...args) => {
  if (path !== image) return opendirSync(path, ...args);
  let index = 0;
  return {
    readSync: () => index < entries.length ? { name: entries[index++] } : null,
    closeSync: () => undefined
  };
};
`
    );
    const exportBundle = () =>
      actions(undefined, entry).exportComposeBundle(request("export_supported_compose_bundle"));
    await expect(exportBundle()).resolves.toMatchObject({ state: "exported" });
    const previous = await readFile(bundlePath);
    const archive = unzipSync(previous);
    expect(Object.keys(archive)).toHaveLength(65_535);
    expect(new TextDecoder().decode(archive["compose.yaml"])).toBe("services: {}\n");
    expect(archive["image/resource-65528"]).toHaveLength(0);

    await writeFile(extraEntry, "");
    await expect(exportBundle()).resolves.toMatchObject({ state: "invalid_project" });
    expect(await readFile(bundlePath)).toEqual(previous);
    expect((await readdir(root)).sort()).toEqual([
      "append-entry",
      "archive-fixture-worker.cjs",
      "bundle.zip",
      "empty.bin",
      "resource"
    ]);
  }, 30_000);

  it.skipIf(process.platform === "win32")(
    "replaces a readable archive with a private ZIP",
    async () => {
      const { root, bundlePath, exportBundle } = await exportFixture();
      await writeFile(bundlePath, oldBundle);
      await chmod(bundlePath, 0o644);

      await expect(exportBundle()).resolves.toMatchObject({
        state: "exported",
        fileName: "bundle.zip"
      });
      expect((await stat(bundlePath)).mode & 0o777).toBe(0o600);
      const archive = unzipSync(await readFile(bundlePath));
      expect(
        Buffer.from(archive[".operator-token"]).equals(Buffer.from(`${operatorToken}\n`))
      ).toBe(true);
      expect((await readdir(root)).sort()).toEqual(["bundle.zip", "resource"]);
    }
  );

  it.skipIf(process.platform !== "darwin")(
    "does not inherit a macOS ACL that grants ZIP read access",
    async () => {
      const { root, bundlePath, exportBundle } = await exportFixture();
      expect(
        spawnSync("/bin/chmod", ["+a", "everyone allow read,file_inherit,directory_inherit", root])
          .status
      ).toBe(0);

      await expect(exportBundle()).resolves.toMatchObject({ state: "exported" });
      const acl = spawnSync("/bin/ls", ["-le", bundlePath], { encoding: "utf8" });
      expect(acl.status).toBe(0);
      expect(acl.stdout.trimEnd().split("\n")).toHaveLength(1);
    }
  );

  it.skipIf(process.platform === "win32").each(["file", "missing"])(
    "rejects a symbolic link to a %s destination without following it",
    async (targetKind) => {
      const { root, bundlePath, exportBundle } = await exportFixture();
      const linkedPath = join(root, "linked.zip");
      if (targetKind === "file") await writeFile(linkedPath, oldBundle);
      await symlink(linkedPath, bundlePath);

      await expect(exportBundle()).rejects.toMatchObject({
        code: "deployment_archive_destination_not_file"
      });
      expect(await readlink(bundlePath)).toBe(linkedPath);
      if (targetKind === "file") {
        expect(await readFile(linkedPath)).toEqual(oldBundle);
      } else {
        await expect(lstat(linkedPath)).rejects.toMatchObject({ code: "ENOENT" });
      }
    }
  );

  it("rejects a directory destination without changing its contents", async () => {
    const { root, bundlePath, exportBundle } = await exportFixture();
    await mkdir(bundlePath);
    const child = join(bundlePath, "keep");
    await writeFile(child, oldBundle);

    await expect(exportBundle()).rejects.toMatchObject({
      code: "deployment_archive_destination_not_file"
    });
    expect(await readFile(child)).toEqual(oldBundle);
    expect((await readdir(root)).sort()).toEqual(["bundle.zip", "resource"]);
  });

  it("preserves the old ZIP when Windows cannot secure the empty staging file", async () => {
    const { root, bundlePath, exportBundle } = await exportFixture();
    await writeFile(bundlePath, oldBundle);
    const failure = fsFailure("EACCES");
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(WindowsPrivateStorageSecurity.prototype, "prepareDirectory").mockResolvedValueOnce(
      undefined
    );
    vi.spyOn(WindowsPrivateStorageSecurity.prototype, "secureFile").mockImplementationOnce(
      async (path) => {
        expect((await stat(path)).size).toBe(0);
        throw failure;
      }
    );

    try {
      await expect(exportBundle()).rejects.toMatchObject({
        code: "deployment_archive_permissions_unavailable",
        cause: failure
      });
    } finally {
      platform.mockRestore();
    }
    expect((await readFile(bundlePath)).equals(oldBundle)).toBe(true);
    expect((await readdir(root)).sort()).toEqual(["bundle.zip", "resource"]);
  });

  it("replaces the selected hard link without changing the old inode's bytes", async () => {
    const { root, bundlePath, exportBundle } = await exportFixture();
    const linkedPath = join(root, "linked.zip");
    await writeFile(linkedPath, oldBundle);
    await link(linkedPath, bundlePath);

    await expect(exportBundle()).resolves.toMatchObject({ state: "exported" });
    expect((await readFile(linkedPath)).equals(oldBundle)).toBe(true);
    expect((await stat(bundlePath)).ino).not.toBe((await stat(linkedPath)).ino);
    const archive = unzipSync(await readFile(bundlePath));
    expect(Buffer.from(archive[".operator-token"]).equals(Buffer.from(`${operatorToken}\n`))).toBe(
      true
    );
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "preserves a writable old ZIP in a read-only parent",
    async () => {
      const { root, bundlePath, exportBundle } = await exportFixture();
      await writeFile(bundlePath, oldBundle, { mode: 0o600 });
      await chmod(root, 0o500);
      try {
        await expect(exportBundle()).rejects.toMatchObject({ code: "EACCES" });
        expect(await readFile(bundlePath)).toEqual(oldBundle);
        expect((await readdir(root)).sort()).toEqual(["bundle.zip", "resource"]);
      } finally {
        await chmod(root, 0o700);
      }
    }
  );

  it.skipIf(process.platform === "win32")(
    "does not follow a link introduced immediately before rename",
    async () => {
      const { root, bundlePath, exportBundle } = await exportFixture();
      const linkedPath = join(root, "linked.zip");
      await writeFile(linkedPath, oldBundle);
      vi.mocked(rename).mockImplementationOnce(async (source, destination) => {
        const actual = await vi.importActual<typeof fs>("node:fs/promises");
        await symlink(linkedPath, destination);
        await actual.rename(source, destination);
      });

      await expect(exportBundle()).resolves.toMatchObject({ state: "exported" });
      expect((await lstat(bundlePath)).isFile()).toBe(true);
      expect((await readFile(linkedPath)).equals(oldBundle)).toBe(true);
      expect(await readdir(root)).toHaveLength(3);
    }
  );

  it("publishes complete concurrent exports to a shared destination", async () => {
    const first = await exportFixture();
    const second = await exportFixture(otherToken);
    const bothStaged = Promise.withResolvers<void>();
    let arrivals = 0;
    const actual = await vi.importActual<typeof fs>("node:fs/promises");
    const renameAfterBothStaged: typeof rename = async (source, destination) => {
      if (++arrivals === 2) bothStaged.resolve();
      await bothStaged.promise;
      await actual.rename(source, destination);
    };
    vi.mocked(rename)
      .mockImplementationOnce(renameAfterBothStaged)
      .mockImplementationOnce(renameAfterBothStaged);

    const results = await Promise.all([
      first.exportBundle(),
      second.exportBundle(first.bundlePath)
    ]);
    expect(results.every((result) => result.state === "exported")).toBe(true);
    expect(arrivals).toBe(2);
    const archive = unzipSync(await readFile(first.bundlePath));
    const credentials = Buffer.from(archive[".operator-token"]);
    const config = JSON.parse(Buffer.from(archive["server.json"]).toString("utf8"));
    expect(
      [operatorToken, otherToken].some(
        (token) =>
          credentials.equals(Buffer.from(`${token}\n`)) &&
          config.operatorCredentials[0].tokenSha256 === hashOperatorToken(token)
      )
    ).toBe(true);
    expect((await readdir(first.root)).sort()).toEqual(["bundle.zip", "resource"]);
  });

  it.each([
    "write",
    "sync",
    "rename"
  ] as const)("preserves the old ZIP and cleans temporary data when %s fails", async (stage) => {
    const { root, bundlePath, exportBundle } = await exportFixture();
    await writeFile(bundlePath, oldBundle);
    const failure = failStagedWrite(stage);

    await expect(exportBundle()).rejects.toBe(failure);
    expect((await readFile(bundlePath)).equals(oldBundle)).toBe(true);
    expect((await readdir(root)).sort()).toEqual(["bundle.zip", "resource"]);
  });

  it("preserves the old ZIP and surfaces precommit cleanup failure", async () => {
    const { root, bundlePath, exportBundle } = await exportFixture();
    await writeFile(bundlePath, oldBundle);
    const failure = failStagedWrite("rename");
    const cleanupFailure = fsFailure("EPERM");
    vi.mocked(unlink).mockRejectedValueOnce(cleanupFailure);

    await expect(exportBundle()).rejects.toMatchObject({ errors: [failure, cleanupFailure] });
    expect((await readFile(bundlePath)).equals(oldBundle)).toBe(true);
    const remaining = (await readdir(root)).filter(
      (name) => !["bundle.zip", "resource"].includes(name)
    );
    expect(remaining).toHaveLength(1);
    const staging = join(root, remaining[0]);
    const files = await readdir(staging);
    expect(files).toHaveLength(1);
    if (process.platform !== "win32") {
      expect((await stat(join(staging, files[0]))).mode & 0o777).toBe(0o600);
    }
  });

  it("reports that the ZIP was committed when removing the empty temporary directory fails", async () => {
    const { root, bundlePath, exportBundle } = await exportFixture();
    await writeFile(bundlePath, oldBundle);
    vi.mocked(rmdir).mockRejectedValueOnce(fsFailure("EPERM"));

    await expect(exportBundle()).rejects.toMatchObject({
      code: "deployment_archive_committed_cleanup_failed"
    });
    const archive = unzipSync(await readFile(bundlePath));
    expect(Buffer.from(archive[".operator-token"]).equals(Buffer.from(`${operatorToken}\n`))).toBe(
      true
    );
    const remaining = (await readdir(root)).filter(
      (name) => !["bundle.zip", "resource"].includes(name)
    );
    expect(remaining).toHaveLength(1);
    expect(await readdir(join(root, remaining[0]))).toEqual([]);
  });
});
