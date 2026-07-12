import type { Command } from "commander";
import { execFile } from "node:child_process";
import {
  listProfiles,
  getProfile,
  saveProfile,
  deleteProfile,
  saveCredentials,
  clearCredentials,
  generateDeviceId
} from "../remoteProfile.js";

/**
 * Start a local PlanWeave server for development/testing.
 */
async function startServer(): Promise<void> {
  // Use the same pnpm exec approach the rest of the CLI uses
  try {
    const child = execFile("pnpm", ["--silent", "--filter", "@planweave-ai/mcp", "mcp"], {
      env: { ...process.env }
    });
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);
    await new Promise<void>((resolve, reject) => {
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Server process exited with code ${code}`));
      });
      child.on("error", reject);
    });
  } catch (error) {
    throw new Error(`Failed to start PlanWeave server: ${error instanceof Error ? error.message : String(error)}`);
  }
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
    .action(async (options: { port: string; dataDir?: string }) => {
      await startServer();
    });

  serverCmd
    .command("join")
    .description("Join a remote PlanWeave server")
    .requiredOption("--url <url>", "server URL (e.g. http://localhost:8788)")
    .requiredOption("--name <name>", "profile name for this server connection")
    .requiredOption("--project <id>", "project ID to work on")
    .requiredOption("--user <id>", "user ID to authenticate as")
    .option("--json", "print machine-readable output")
    .action(async (options: { url: string; name: string; project: string; user: string; json?: boolean }) => {
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
      const profile = {
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

      // Also save initial credentials (the real session is obtained on first connect)
      await saveCredentials(options.name, {
        sessionToken: "",
        deviceSecret: ""
      });

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
