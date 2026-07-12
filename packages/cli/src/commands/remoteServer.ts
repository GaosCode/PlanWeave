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
async function startServer(port: number, dataDirectory: string, joinToken: string): Promise<void> {
  const server = await startPlanweaveServer({ dataDirectory, databasePath: resolve(dataDirectory, "planweave-server.sqlite"), host: "0.0.0.0", port, busyTimeoutMs: 5000, joinToken });
  const http = server.createHttpServer();
  await new Promise<void>((resolveListen, reject) => {
    http.once("error", reject);
    http.listen(port, "0.0.0.0", resolveListen);
  });
  console.log(`PlanWeave collaboration server listening on http://0.0.0.0:${port}`);
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
    .option("--join-token <token>", "shared LAN invitation token", "planweave-local-team")
    .action(async (options: { port: string; dataDir?: string; joinToken: string }) => {
      const port = Number(options.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be an integer between 1 and 65535");
      await startServer(port, resolve(options.dataDir ?? ".planweave-server"), options.joinToken);
    });

  serverCmd
    .command("join")
    .description("Join a remote PlanWeave server")
    .requiredOption("--url <url>", "server URL (e.g. http://localhost:8788)")
    .requiredOption("--name <name>", "profile name for this server connection")
    .requiredOption("--project <id>", "project ID to work on")
    .requiredOption("--user <id>", "user ID to authenticate as")
    .option("--token <token>", "team join token", "planweave-local-team")
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
        const response = await fetch(`${profile.serverUrl}/api/v1/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: options.project, userId: options.user, displayName: options.user, deviceId, joinToken: options.token }) });
        const body = await response.json() as { session?: { id: string; expiresAt: string }; error?: { message: string } };
        if (!response.ok || !body.session) throw new Error(body.error?.message ?? `HTTP ${response.status}`);
        profile.sessionId = body.session.id;
        profile.sessionExpiresAt = body.session.expiresAt;
        await saveProfile(profile);
        await saveCredentials(options.name, { sessionToken: body.session.id, deviceSecret: "" });
      } catch (error) {
        await deleteProfile(options.name);
        throw new Error(`Failed to join team server: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (options.json) {
        console.log(JSON.stringify({ kind: "joined", profile }, null, 2));
      } else {
        console.log(`Joined server ${options.url} as user ${options.user} on project ${options.project}.`);
        console.log(`Profile '${options.name}' created. Device ID: ${deviceId}`);
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
