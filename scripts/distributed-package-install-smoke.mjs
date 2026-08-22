#!/usr/bin/env node
/**
 * Clean-install smoke for Coordinator Server + Agent Host packages.
 *
 * Packs the distributed publish graph into a temporary directory, installs the
 * tarballs into a fresh consumer tree (npm), verifies package contents and
 * node:sqlite availability, starts planweave-server serve, runs Agent Host
 * preflight, and lists Host-local ACP profiles.
 *
 * Usage:
 *   node scripts/distributed-package-install-smoke.mjs
 *   node scripts/distributed-package-install-smoke.mjs --report /tmp/distributed-install-smoke.json
 *   node scripts/distributed-package-install-smoke.mjs --skip-build
 *
 * Does not embed secrets. Does not claim REAL_ACP or remote VPS evidence.
 */
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, cp, writeFile, access } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { createRequire } from "node:module";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

function flagValue(name) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

const reportPath = flagValue("--report");
const skipBuild = args.includes("--skip-build");
const keepTemp = args.includes("--keep-temp");

const packOrder = [
  "agent-host-protocol",
  "collaboration-protocol",
  "runtime",
  "server",
  "agent-host"
];

const collaborationProtocolModules = [
  ["core/primitives", "primitives"],
  ["core/limits", "limits"],
  ["errors", "errors"],
  ["identity/workspace", "identity"],
  ["identity/migration", "migration"],
  ["access/project", "projectAccess"],
  ["access/control", "accessControl"],
  ["content/snapshot", "packageSnapshot"],
  ["content/version", "contentVersion"],
  ["content/transfer", "contentVersionTransfer"],
  ["work/assignment", "assignment"],
  ["work/responsibility", "responsibility"],
  ["work/review", "review"],
  ["work/execution-target", "executionTarget"],
  ["work/host-authorization", "hostAuthorization"],
  ["work/authority", "workAuthority"],
  ["work/assignment-migration", "assignmentMigration"],
  ["canvas/commands", "canvasCommands"],
  ["canvas/live-sync", "canvasLiveSync"],
  ["canvas/status", "runtimeStatus"],
  ["canvas/presence", "presence"],
  ["activity/comments", "comments"],
  ["activity/attachments", "attachments"],
  ["activity/observer", "observer"],
  ["connection", "connection"],
  ["setup", "setup"],
  ["handoff/setup", "setupHandoff"],
  ["handoff/invitation", "invitationHandoff"],
  ["deployment", "deployment"],
  ["loopback", "loopbackServer"],
  ["remote-run", "remoteRun"],
  ["fixtures/collaboration", "fixtures/collaboration"],
  ["fixtures/content-version", "fixtures/contentVersion"]
];

const packageMeta = {
  "agent-host-protocol": {
    name: "@planweave-ai/agent-host-protocol",
    dir: "packages/agent-host-protocol",
    requiredPaths: ["dist/index.js", "dist/compatibility.js", "dist/version.js"]
  },
  "collaboration-protocol": {
    name: "@planweave-ai/collaboration-protocol",
    dir: "packages/collaboration-protocol",
    requiredPaths: collaborationProtocolModules.flatMap(([, target]) => [
      `dist/${target}.js`,
      `dist/${target}.d.ts`
    ])
  },
  runtime: {
    name: "@planweave-ai/runtime",
    dir: "packages/runtime",
    requiredPaths: ["dist/index.js"]
  },
  server: {
    name: "@planweave-ai/server",
    dir: "packages/server",
    requiredPaths: ["dist/bin.js", "dist/migrations.js", "dist/index.js"],
    bin: "planweave-server"
  },
  "agent-host": {
    name: "@planweave-ai/agent-host",
    dir: "packages/agent-host",
    requiredPaths: ["dist/bin.js", "dist/index.js"],
    bin: "planweave-agent-host"
  }
};

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function run(command, commandArgs, options = {}) {
  execFileSync(command, commandArgs, {
    cwd: options.cwd ?? repoRoot,
    stdio: options.stdio ?? "inherit",
    env: options.env ?? process.env,
    encoding: "utf8"
  });
}

function runCapture(command, commandArgs, options = {}) {
  return execFileSync(command, commandArgs, {
    cwd: options.cwd ?? repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: options.env ?? process.env,
    encoding: "utf8"
  });
}

function parseConsumerAudit(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("consumer_audit_response_invalid", { cause: error });
  }
  const vulnerabilities = parsed?.metadata?.vulnerabilities;
  for (const severity of ["info", "low", "moderate", "high", "critical", "total"]) {
    if (!Number.isInteger(vulnerabilities?.[severity]) || vulnerabilities[severity] < 0) {
      throw new Error(`consumer_audit_count_invalid:${severity}`);
    }
  }
  return {
    productionOnly: true,
    policy: "zero-vulnerabilities",
    auditLevel: "info",
    vulnerabilities: {
      info: vulnerabilities.info,
      low: vulnerabilities.low,
      moderate: vulnerabilities.moderate,
      high: vulnerabilities.high,
      critical: vulnerabilities.critical,
      total: vulnerabilities.total
    }
  };
}

function auditInstalledConsumer(installDir) {
  try {
    const audit = parseConsumerAudit(
      runCapture("npm", ["audit", "--json", "--omit=dev", "--audit-level=info"], {
        cwd: installDir
      })
    );
    if (audit.vulnerabilities.total !== 0) {
      throw new Error(`consumer_audit_vulnerabilities:${audit.vulnerabilities.total}`);
    }
    return audit;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("consumer_audit_")) throw error;
    const stdout = typeof error?.stdout === "string" ? error.stdout : error?.stdout?.toString();
    if (stdout) {
      const audit = parseConsumerAudit(stdout);
      throw new Error(`consumer_audit_vulnerabilities:${audit.vulnerabilities.total}`, {
        cause: error
      });
    }
    throw new Error("consumer_audit_command_failed", { cause: error });
  }
}

async function availablePort() {
  const probe = createServer();
  await new Promise((resolveListen) => probe.listen(0, "127.0.0.1", resolveListen));
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("expected_tcp_port");
  const { port } = address;
  await new Promise((resolveClose) => probe.close(() => resolveClose()));
  return port;
}

function spawnNode(scriptPath, argv, options = {}) {
  return spawn(process.execPath, [scriptPath, ...argv], {
    stdio: ["ignore", "pipe", "pipe"],
    env: options.env ?? process.env,
    cwd: options.cwd
  });
}

async function waitForStdout(child, predicate, budgetMs) {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const started = Date.now();
  while (Date.now() - started < budgetMs) {
    if (predicate(stdout, stderr)) return { stdout, stderr };
    if (child.exitCode !== null) {
      throw new Error(
        `process_exited_before_ready:code=${child.exitCode}:stderr=${stderr.slice(0, 500)}`
      );
    }
    await sleep(50);
  }
  throw new Error(`process_ready_timeout:stderr=${stderr.slice(0, 500)}`);
}

async function runToCompletion(child, budgetMs) {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolveClose, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`process_timeout:${budgetMs}`));
    }, budgetMs);
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolveClose(exitCode ?? 1);
    });
  });
  return { code, stdout, stderr };
}

function assertNoNativeBindings(packageRoot) {
  const stack = [packageRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        stack.push(path);
      } else if (entry.isFile() && entry.name.endsWith(".node")) {
        throw new Error(`unexpected_native_binding:${path}`);
      }
    }
  }
}

function inspectTarball(tarballPath, meta) {
  const listing = runCapture("tar", ["-tzf", tarballPath])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const packageJsonEntry = listing.find((line) => line === "package/package.json");
  if (!packageJsonEntry) throw new Error(`tarball_missing_package_json:${meta.name}`);
  const packageJson = JSON.parse(runCapture("tar", ["-xOf", tarballPath, "package/package.json"]));
  if (packageJson.name !== meta.name) {
    throw new Error(`tarball_name_mismatch:${packageJson.name}`);
  }
  if (packageJson.engines?.node !== ">=22.13") {
    throw new Error(`tarball_engines_unexpected:${packageJson.engines?.node}`);
  }
  if (packageJson.license !== "MIT") {
    throw new Error(`tarball_license_unexpected:${packageJson.license}`);
  }
  if (!listing.includes("package/LICENSE")) {
    throw new Error(`tarball_missing_license:${meta.name}`);
  }
  for (const relativePath of meta.requiredPaths) {
    if (!listing.includes(`package/${relativePath}`)) {
      throw new Error(`tarball_missing_path:${meta.name}:${relativePath}`);
    }
  }
  if (meta.bin) {
    if (packageJson.bin?.[meta.bin] !== "./dist/bin.js") {
      throw new Error(`tarball_bin_missing:${meta.name}:${meta.bin}`);
    }
  }
  const hasWorkspaceProtocol = JSON.stringify(packageJson.dependencies ?? {}).includes(
    "workspace:"
  );
  if (hasWorkspaceProtocol) {
    throw new Error(`tarball_workspace_protocol_leaked:${meta.name}`);
  }
  return {
    name: packageJson.name,
    version: packageJson.version,
    engines: packageJson.engines,
    bin: packageJson.bin ?? null,
    license: packageJson.license ?? null,
    licenseFile: true,
    dependencyNames: Object.keys(packageJson.dependencies ?? {}).sort(),
    pathsPresent: meta.requiredPaths
  };
}

async function main() {
  const startedAt = new Date().toISOString();
  const workRoot = mkdtempSync(join(tmpdir(), "planweave-distributed-pack-smoke-"));
  const redactEvidenceText = (value) =>
    value.replaceAll(repoRoot, "<repo-root>").replaceAll(workRoot, "<temporary-root>");
  const packDir = join(workRoot, "pack");
  const installDir = join(workRoot, "install");
  const smokeDir = join(workRoot, "smoke");
  await mkdir(packDir, { recursive: true });
  await mkdir(installDir, { recursive: true });
  await mkdir(smokeDir, { recursive: true });

  const report = {
    schemaVersion: 1,
    kind: "planweave.distributed-package-install-smoke/v1",
    generatedAt: startedAt,
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      pnpm: null,
      cwd: "<redacted>"
    },
    packages: [],
    install: null,
    server: null,
    agentHost: null,
    acpProfiles: null,
    nativeSqlite: null,
    result: "failed"
  };

  try {
    report.environment.pnpm = runCapture("pnpm", ["--version"]).trim();

    if (!skipBuild) {
      run("pnpm", [
        "--filter",
        "@planweave-ai/agent-host-protocol",
        "--filter",
        "@planweave-ai/collaboration-protocol",
        "--filter",
        "@planweave-ai/runtime",
        "--filter",
        "@planweave-ai/server",
        "--filter",
        "@planweave-ai/agent-host",
        "build"
      ]);
    }

    const tarballs = [];
    for (const key of packOrder) {
      const meta = packageMeta[key];
      run("pnpm", ["--dir", meta.dir, "pack", "--pack-destination", packDir]);
      const expected = join(
        packDir,
        `${meta.name.replace("@", "").replace("/", "-")}-${JSON.parse(readFileSync(join(repoRoot, meta.dir, "package.json"), "utf8")).version}.tgz`
      );
      if (!existsSync(expected)) {
        const found = readdirSync(packDir).filter((name) => name.endsWith(".tgz"));
        throw new Error(`packed_tarball_missing:${expected};found=${found.join(",")}`);
      }
      const inspection = inspectTarball(expected, meta);
      const artifact = {
        key,
        path: expected,
        sha256: sha256File(expected),
        bytes: readFileSync(expected).byteLength,
        inspection
      };
      tarballs.push(artifact);
      report.packages.push({
        key: artifact.key,
        fileName: basename(artifact.path),
        sha256: artifact.sha256,
        bytes: artifact.bytes,
        inspection: artifact.inspection
      });
    }

    writeFileSync(
      join(installDir, "package.json"),
      JSON.stringify(
        { name: "planweave-distributed-install-smoke", private: true, type: "module" },
        null,
        2
      )
    );
    run("npm", ["install", "--no-fund", "--no-audit", ...tarballs.map((item) => item.path)], {
      cwd: installDir
    });
    const consumerAudit = auditInstalledConsumer(installDir);

    const collaborationImportSmokePath = join(installDir, "collaboration-import-smoke.mjs");
    writeFileSync(
      collaborationImportSmokePath,
      [
        `const packageName = ${JSON.stringify(packageMeta["collaboration-protocol"].name)};`,
        `const subpaths = ${JSON.stringify(collaborationProtocolModules.map(([subpath]) => subpath))};`,
        "for (const subpath of subpaths) await import(`${packageName}/${subpath}`);",
        "try {",
        "  await import(packageName);",
        '  throw new Error("collaboration_protocol_root_export_available");',
        "} catch (error) {",
        '  if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;',
        "}"
      ].join("\n")
    );
    run(process.execPath, [collaborationImportSmokePath], { cwd: installDir });

    const serverPackageRoot = join(installDir, "node_modules/@planweave-ai/server");
    const hostPackageRoot = join(installDir, "node_modules/@planweave-ai/agent-host");
    for (const relativePath of packageMeta.server.requiredPaths) {
      await access(join(serverPackageRoot, relativePath));
    }
    for (const relativePath of packageMeta["agent-host"].requiredPaths) {
      await access(join(hostPackageRoot, relativePath));
    }
    assertNoNativeBindings(serverPackageRoot);
    assertNoNativeBindings(hostPackageRoot);

    const serverPublicApi = await import(
      pathToFileURL(join(serverPackageRoot, "dist/index.js")).href
    );
    if ("DispatchService" in serverPublicApi) {
      throw new Error("server_public_dispatch_service_bypasses_coordinator");
    }
    if (typeof serverPublicApi.createRemoteBlockCoordination !== "function") {
      throw new Error("server_public_coordinator_missing");
    }

    const require = createRequire(join(installDir, "package.json"));
    const { DatabaseSync } = require("node:sqlite");
    const memoryDb = new DatabaseSync(":memory:");
    memoryDb.exec("CREATE TABLE smoke(id INTEGER PRIMARY KEY); INSERT INTO smoke(id) VALUES (1);");
    const row = memoryDb.prepare("SELECT id FROM smoke").get();
    memoryDb.close();
    if (row?.id !== 1) throw new Error("node_sqlite_smoke_failed");
    report.nativeSqlite = {
      provider: "node:sqlite",
      ok: true,
      note: "Server and Agent Host use Node built-in sqlite; no better-sqlite3/node-gyp package dependency."
    };

    report.install = {
      manager: "npm",
      root: "<redacted>",
      audit: consumerAudit,
      bins: {
        "planweave-server": existsSync(join(installDir, "node_modules/.bin/planweave-server")),
        "planweave-agent-host": existsSync(
          join(installDir, "node_modules/.bin/planweave-agent-host")
        )
      }
    };

    const runtime = await import(
      pathToFileURL(join(installDir, "node_modules/@planweave-ai/runtime/dist/index.js")).href
    );
    const projectRoot = join(smokeDir, "project");
    await mkdir(join(projectRoot, "package"), { recursive: true });
    await cp(join(repoRoot, "examples/basic-plan-package/package"), join(projectRoot, "package"), {
      recursive: true
    });
    const init = await runtime.initWorkspace({ projectRoot });

    const port = await availablePort();
    const token = "serve_admin_token_abcdefghijklmnopqrstuvwxyz0123";
    const tokenSha256 = createHash("sha256").update(token).digest("hex");
    const serverConfigPath = join(smokeDir, "server.json");
    await writeFile(
      serverConfigPath,
      JSON.stringify({
        version: "server-config/v1",
        bind: { host: "127.0.0.1", port },
        publicUrl: `http://127.0.0.1:${port}`,
        allowInsecureDevelopment: true,
        dataDirectory: join(smokeDir, "server-data"),
        trustedProjects: [
          {
            workspaceId: "workspace-1",
            projectId: init.workspace.id,
            canvasId: "default",
            projectRoot
          }
        ],
        operatorCredentials: [
          {
            operatorId: "admin",
            tokenSha256,
            projectIds: [],
            serverAdmin: true
          }
        ]
      })
    );

    const hostWorkspaceRoot = join(smokeDir, "host-workspace");
    await mkdir(join(hostWorkspaceRoot, "project"), { recursive: true });
    const hostConfigPath = join(smokeDir, "host.json");
    await writeFile(
      hostConfigPath,
      JSON.stringify({
        version: "agent-host-config/v1",
        coordinator: {
          url: `http://127.0.0.1:${port}`,
          allowInsecureDevelopment: true
        },
        dataDirectory: join(smokeDir, "host-data"),
        workspaceRoot: hostWorkspaceRoot,
        host: {
          displayName: "distributed-install-smoke-host",
          capacity: 1,
          capabilities: ["acp.test"]
        },
        workspaces: [{ id: "workspace-1", path: "project" }],
        agentProfiles: [
          {
            id: "profile-1",
            agentId: "agent-1",
            command: "/usr/bin/env",
            args: ["true"],
            environment: []
          }
        ]
      })
    );

    const serverBin = join(serverPackageRoot, "dist/bin.js");
    const hostBin = join(hostPackageRoot, "dist/bin.js");
    const server = spawnNode(serverBin, ["serve", "--config", serverConfigPath]);
    try {
      const ready = await waitForStdout(
        server,
        (stdout) => stdout.includes('"status":"ready"'),
        20_000
      );
      const readyLine = ready.stdout
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.startsWith("{") && line.includes('"status":"ready"'));
      const readyJson = readyLine ? JSON.parse(readyLine) : null;

      const health = await fetch(`http://127.0.0.1:${port}/healthz`);
      const readiness = await fetch(`http://127.0.0.1:${port}/readyz`);
      const version = await fetch(`http://127.0.0.1:${port}/version`);
      const readinessBody = await readiness.json();
      const versionBody = await version.json();
      if (health.status !== 200) throw new Error(`healthz_status:${health.status}`);
      if (readiness.status !== 200 || readinessBody.status !== "ready") {
        throw new Error(`readyz_failed:${JSON.stringify(readinessBody)}`);
      }
      if (version.status !== 200 || versionBody.protocolVersion !== 1) {
        throw new Error(`version_failed:${JSON.stringify(versionBody)}`);
      }

      report.server = {
        ready: readyJson,
        healthz: health.status,
        readyz: readinessBody,
        version: versionBody
      };

      const preflight = await runToCompletion(
        spawnNode(hostBin, ["preflight", "--config", hostConfigPath]),
        15_000
      );
      if (preflight.code !== 0) {
        throw new Error(`agent_host_preflight_failed:${preflight.stderr || preflight.stdout}`);
      }
      report.agentHost = {
        preflight: JSON.parse(preflight.stdout.trim())
      };

      const profiles = await runToCompletion(
        spawnNode(hostBin, ["real-acp-smoke", "--list-profiles"]),
        15_000
      );
      if (profiles.code !== 0) {
        throw new Error(`list_profiles_failed:${profiles.stderr || profiles.stdout}`);
      }
      report.acpProfiles = JSON.parse(profiles.stdout.trim());
    } finally {
      if (server.exitCode === null) {
        server.kill("SIGTERM");
        await Promise.race([
          new Promise((resolveClose) => server.once("close", resolveClose)),
          sleep(5_000)
        ]);
        if (server.exitCode === null) server.kill("SIGKILL");
      }
    }

    report.result = "passed";
    report.finishedAt = new Date().toISOString();
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (reportPath) {
      await mkdir(dirname(resolve(reportPath)), { recursive: true });
      writeFileSync(reportPath, serialized);
    }
    process.stdout.write(serialized);
    process.exitCode = 0;
  } catch (error) {
    report.result = "failed";
    report.error = redactEvidenceText(error instanceof Error ? error.message : String(error));
    report.finishedAt = new Date().toISOString();
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (reportPath) {
      try {
        await mkdir(dirname(resolve(reportPath)), { recursive: true });
        writeFileSync(reportPath, serialized);
      } catch {
        // ignore report write failures on the failure path
      }
    }
    process.stderr.write(serialized);
    process.exitCode = 1;
  } finally {
    if (!keepTemp) {
      try {
        rmSync(workRoot, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    } else {
      process.stderr.write(`kept_temp=${workRoot}\n`);
    }
  }
}

await main();
