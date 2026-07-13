import type { Command } from "commander";
import { resolve } from "node:path";
import { startPlanweaveServer } from "@planweave-ai/server";
import {
  listProfiles,
  getProfile,
  saveProfile,
  deleteProfile,
  saveCredentials,
  clearCredentials,
  generateDeviceId
} from "../remoteProfile.js";
import type { RemoteProfile } from "../remoteProfile.js";

/**
 * Start a local PlanWeave server for development/testing.
 */
async function startServer(port: number, dataDirectory: string, joinToken: string, allowInsecureLan: boolean, repositoryPath?: string, targetBranch = "main", checks?: string[]): Promise<void> {
  const host = allowInsecureLan ? "0.0.0.0" : "127.0.0.1";
  const server = await startPlanweaveServer({ dataDirectory, databasePath: resolve(dataDirectory, "planweave-server.sqlite"), host, port, busyTimeoutMs: 5000, joinToken, ...(repositoryPath ? { repositoryPath: resolve(repositoryPath), targetBranch, repositoryChecks: checks?.length ? checks : ["pnpm-lint", "pnpm-build", "pnpm-test"], requireMergeApproval: true } : {}) });
  const http = server.createHttpServer();
  await new Promise<void>((resolveListen, reject) => {
    http.once("error", reject);
    http.listen(port, host, resolveListen);
  });
  console.log(`PlanWeave collaboration server listening on http://${host}:${port}`);
  if (!repositoryPath) console.warn("Warning: no --repository was configured; discussion and boards work, but durable bundle review and merge are disabled.");
  if (allowInsecureLan) console.warn("Warning: LAN mode uses plaintext HTTP. Use it only on a trusted network.");
  const shutdown = () => { http.close(() => { server.close(); process.exit(0); }); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await new Promise<void>(() => {});
}

export function registerRemoteServerCommand(program: Command): void {
  const serverCmd = program
    .command("server")
    .description("Manage PlanWeave remote server connections");

  serverCmd
    .command("start")
    .description("Start a local PlanWeave server")
    .option("--port <port>", "port to listen on", "8788")
    .option("--data-dir <path>", "data directory for the server")
    .option("--allow-insecure-lan", "listen on all interfaces using plaintext HTTP")
    .option("--repository <path>", "Host Git repository used to initialize the durable integration repository")
    .option("--target-branch <branch>", "Host integration target branch", "main")
    .option("--checks <names>", "comma-separated Host checks: pnpm-lint,pnpm-build,pnpm-test")
    .requiredOption("--join-token <token>", "high-entropy team invitation token")
    .action(async (options: { port: string; dataDir?: string; joinToken: string; allowInsecureLan?: boolean; repository?: string; targetBranch: string; checks?: string }) => {
      const port = Number(options.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be an integer between 1 and 65535");
      if (options.joinToken.trim().length < 24) throw new Error("--join-token must contain at least 24 characters");
      const checks = options.checks?.split(",").map((value) => value.trim()).filter(Boolean);
      await startServer(port, resolve(options.dataDir ?? ".planweave-server"), options.joinToken, options.allowInsecureLan === true, options.repository, options.targetBranch, checks);
    });

  serverCmd
    .command("join")
    .description("Join a remote PlanWeave server")
    .requiredOption("--url <url>", "server URL (e.g. http://localhost:8788)")
    .requiredOption("--name <name>", "profile name for this server connection")
    .requiredOption("--project <id>", "project ID to work on")
    .requiredOption("--user <id>", "user ID to authenticate as")
    .requiredOption("--token <token>", "team join token")
    .option("--json", "print machine-readable output")
    .action(async (options: { url: string; name: string; project: string; user: string; token: string; json?: boolean }) => {
      const existing = await getProfile(options.name);
      if (existing) {
        if (options.json) {
          console.log(JSON.stringify({ kind: "blocked", reason: `Profile '${options.name}' already exists.`, profile: existing }, null, 2));
        } else {
          console.log(`Profile '${options.name}' already exists.`);
        }
        return;
      }

      const deviceId = generateDeviceId();
      const now = new Date().toISOString();
      const profile: RemoteProfile = {
        name: options.name,
        serverUrl: options.url.replace(/\/+$/, ""),
        projectId: options.project,
        deviceId,
        userId: options.user,
        sessionId: null,
        sessionExpiresAt: null,
        currentAssignmentId: null,
        currentAssignmentVersion: null,
        currentTaskId: null,
        createdAt: now,
        updatedAt: now
      };

      await saveProfile(profile);
      try {
        const response = await fetch(`${profile.serverUrl}/api/v1/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: options.project, displayName: options.user, deviceName: deviceId, joinToken: options.token }) });
        const body = await response.json() as { session?: { id: string; expiresAt: string }; resumeToken?: string; userId?: string; deviceId?: string; error?: { message: string } };
        if (!response.ok || !body.session || !body.userId || !body.deviceId) throw new Error(body.error?.message ?? `HTTP ${response.status}`);
        profile.userId = body.userId;
        profile.deviceId = body.deviceId;
        profile.sessionId = body.session.id;
        profile.sessionExpiresAt = body.session.expiresAt;
        await saveProfile(profile);
        await saveCredentials(options.name, { sessionToken: body.session.id, deviceSecret: body.resumeToken ?? "" });
      } catch (error) {
        await deleteProfile(options.name);
        throw new Error(`Failed to join team server: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (options.json) {
        console.log(JSON.stringify({ kind: "joined", profile }, null, 2));
      } else {
        console.log(`Joined server ${options.url} as ${options.user} on project ${options.project}.`);
        console.log(`Profile '${options.name}' created. User ID: ${profile.userId}; Device ID: ${profile.deviceId}`);
      }
    });

  serverCmd
    .command("project")
    .description("Set the active project for a profile")
    .requiredOption("--profile <name>", "profile name")
    .requiredOption("--id <id>", "project ID")
    .option("--json", "print machine-readable output")
    .action(async (options: { profile: string; id: string; json?: boolean }) => {
      const profile = await getProfile(options.profile);
      if (!profile) {
        if (options.json) {
          console.log(JSON.stringify({ kind: "blocked", reason: `Profile '${options.profile}' not found.` }, null, 2));
        } else {
          console.log(`Profile '${options.profile}' not found. Run 'planweave server join' first.`);
        }
        return;
      }
      profile.projectId = options.id;
      profile.updatedAt = new Date().toISOString();
      await saveProfile(profile);
      if (options.json) {
        console.log(JSON.stringify({ kind: "updated", profile }, null, 2));
      } else {
        console.log(`Profile '${options.profile}' project set to '${options.id}'.`);
      }
    });

  serverCmd
    .command("list")
    .description("List all server profiles")
    .option("--json", "print machine-readable output")
    .action(async (options: { json?: boolean }) => {
      const profiles = await listProfiles();
      if (options.json) {
        console.log(JSON.stringify({ profiles }, null, 2));
      } else if (profiles.length === 0) {
        console.log("No profiles configured. Use 'planweave server join' to get started.");
      } else {
        for (const p of profiles) {
          console.log(`${p.name}: ${p.serverUrl} (project: ${p.projectId}, user: ${p.userId})`);
        }
      }
    });

  serverCmd
    .command("forget")
    .description("Remove a server profile and its credentials")
    .requiredOption("--name <name>", "profile name to forget")
    .option("--json", "print machine-readable output")
    .action(async (options: { name: string; json?: boolean }) => {
      await clearCredentials(options.name);
      const deleted = await deleteProfile(options.name);
      if (options.json) {
        console.log(JSON.stringify({ kind: deleted ? "removed" : "not_found", name: options.name }, null, 2));
      } else {
        console.log(deleted ? `Profile '${options.name}' removed.` : `Profile '${options.name}' not found.`);
      }
    });
}
