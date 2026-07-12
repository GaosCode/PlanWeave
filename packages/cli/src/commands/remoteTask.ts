import type { Command } from "commander";
import { getProfile, updateProfileAssignment } from "../remoteProfile.js";
import { connectRemoteClient, RemoteApiError, type RemoteClient } from "../remoteClient.js";

function profileRequiredJson(kind: string, reason: string): void {
  console.log(JSON.stringify({ kind, reason }, null, 2));
}

async function resolveClient(profileName: string): Promise<RemoteClient> {
  const profile = await getProfile(profileName);
  if (!profile) {
    throw new Error(`Profile '${profileName}' not found. Run 'planweave server join' first.`);
  }
  return connectRemoteClient(profile);
}

function handleRemoteError(error: unknown, json: boolean): void {
  if (error instanceof RemoteApiError) {
    if (json) {
      console.log(JSON.stringify({
        kind: "error",
        code: error.code,
        message: error.message,
        requestId: error.requestId,
        retryable: error.retryable,
        details: error.details
      }, null, 2));
    } else {
      console.log(`Remote error [${error.code}]: ${error.message}`);
    }
    return;
  }
  if (error instanceof Error) {
    if (json) {
      console.log(JSON.stringify({ kind: "error", message: error.message }, null, 2));
    } else {
      console.log(`Error: ${error.message}`);
    }
    return;
  }
  if (json) {
    console.log(JSON.stringify({ kind: "error", message: String(error) }, null, 2));
  } else {
    console.log(`Error: ${String(error)}`);
  }
}

export function registerRemoteTaskCommand(program: Command): void {
  const taskCmd = program
    .command("task")
    .description("Remote task coordination commands");

  taskCmd
    .command("claim")
    .description("Claim a task from the remote server")
    .requiredOption("--profile <name>", "server profile name")
    .requiredOption("--task-id <id>", "task ID to claim")
    .requiredOption("--branch <name>", "branch name to create")
    .requiredOption("--base-commit <sha>", "base commit SHA")
    .option("--lease-seconds <n>", "lease duration in seconds", "3600")
    .option("--json", "print machine-readable output")
    .action(async (options: { profile: string; taskId: string; branch: string; baseCommit: string; leaseSeconds: string; json?: boolean }) => {
      try {
        const profile = await getProfile(options.profile);
        if (!profile) {
          profileRequiredJson("blocked", `Profile '${options.profile}' not found.`);
          return;
        }
        const client = await connectRemoteClient(profile);
        const result = await client.claimTask({
          taskId: options.taskId,
          branchName: options.branch,
          baseCommit: options.baseCommit,
          leaseDurationSeconds: parseInt(options.leaseSeconds, 10),
          currentAssignmentId: profile.currentAssignmentId,
          currentAssignmentVersion: profile.currentAssignmentVersion
        });
        if (options.json) {
          console.log(JSON.stringify({ kind: "claimed", replayed: result.replayed, assignment: result.assignment, task: result.task }, null, 2));
        } else {
          if (result.replayed) {
            console.log("Claim replayed (idempotent).");
          } else {
            console.log(`Task '${options.taskId}' claimed.`);
          }
          console.log(`Assignment: ${result.assignment.id} (v${result.assignment.version})`);
          console.log(`Branch: ${result.assignment.branchName}`);
          console.log(`Lease expires: ${result.assignment.leaseExpiresAt}`);
        }
      } catch (error) {
        handleRemoteError(error, options.json ?? false);
      }
    });

  taskCmd
    .command("heartbeat")
    .description("Send heartbeat to extend lease on current assignment")
    .requiredOption("--profile <name>", "server profile name")
    .option("--lease-seconds <n>", "lease duration in seconds", "3600")
    .option("--json", "print machine-readable output")
    .action(async (options: { profile: string; leaseSeconds: string; json?: boolean }) => {
      try {
        const profile = await getProfile(options.profile);
        if (!profile) {
          profileRequiredJson("blocked", `Profile '${options.profile}' not found.`);
          return;
        }
        if (!profile.currentAssignmentId || !profile.currentAssignmentVersion) {
          profileRequiredJson("blocked", "No active assignment. Claim a task first.");
          return;
        }
        const client = await connectRemoteClient(profile);
        const result = await client.heartbeat({
          assignmentId: profile.currentAssignmentId,
          assignmentVersion: profile.currentAssignmentVersion,
          leaseDurationSeconds: parseInt(options.leaseSeconds, 10)
        });
        await updateProfileAssignment(options.profile, {
          assignmentId: result.assignment.id,
          assignmentVersion: result.assignment.version,
          taskId: profile.currentTaskId ?? ""
        });
        if (options.json) {
          console.log(JSON.stringify({ kind: "heartbeated", replayed: result.replayed, assignment: result.assignment, newLeaseExpiresAt: result.newLeaseExpiresAt }, null, 2));
        } else {
          console.log(`Heartbeat sent. Lease extended to ${result.newLeaseExpiresAt}`);
        }
      } catch (error) {
        handleRemoteError(error, options.json ?? false);
      }
    });

  taskCmd
    .command("checkout")
    .description("Create a local git branch for the claimed task")
    .requiredOption("--profile <name>", "server profile name")
    .option("--json", "print machine-readable output")
    .action(async (options: { profile: string; json?: boolean }) => {
      try {
        const profile = await getProfile(options.profile);
        if (!profile) {
          profileRequiredJson("blocked", `Profile '${options.profile}' not found.`);
          return;
        }
        if (!profile.currentAssignmentId) {
          profileRequiredJson("blocked", "No active assignment. Run 'planweave task claim' first.");
          return;
        }
        const client = await connectRemoteClient(profile);

        // Get the assignment details from events to find branch name
        const snapshot = await client.getSnapshot();
        const branchName = `pw/${profile.currentTaskId ?? "task"}-${profile.currentAssignmentId.slice(0, 8)}`;

        if (options.json) {
          console.log(JSON.stringify({
            kind: "checkout",
            branchName,
            projectId: profile.projectId,
            assignmentId: profile.currentAssignmentId,
            lastEventId: snapshot.lastEventId
          }, null, 2));
        } else {
          console.log(`Branch '${branchName}' is ready for checkout.`);
          console.log(`Run: git checkout -b ${branchName}`);
          console.log(`Project: ${profile.projectId}`);
          console.log(`Assignment: ${profile.currentAssignmentId}`);
        }
      } catch (error) {
        handleRemoteError(error, options.json ?? false);
      }
    });

  taskCmd
    .command("submit")
    .description("Submit completed work for review")
    .requiredOption("--profile <name>", "server profile name")
    .requiredOption("--head-commit <sha>", "head commit SHA of the completed work")
    .option("--base-commit <sha>", "base commit SHA (defaults to the assignment base)")
    .option("--json", "print machine-readable output")
    .action(async (options: { profile: string; headCommit: string; baseCommit?: string; json?: boolean }) => {
      try {
        const profile = await getProfile(options.profile);
        if (!profile) {
          profileRequiredJson("blocked", `Profile '${options.profile}' not found.`);
          return;
        }
        if (!profile.currentAssignmentId || !profile.currentAssignmentVersion) {
          profileRequiredJson("blocked", "No active assignment. Claim a task first.");
          return;
        }
        const client = await connectRemoteClient(profile);
        const result = await client.submit({
          assignmentId: profile.currentAssignmentId,
          assignmentVersion: profile.currentAssignmentVersion,
          headCommit: options.headCommit,
          baseCommit: options.baseCommit ?? "HEAD~1"
        });
        if (options.json) {
          console.log(JSON.stringify({ kind: "submitted", replayed: result.replayed, submission: result.submission, assignment: result.assignment }, null, 2));
        } else {
          if (result.replayed) {
            console.log("Submission replayed (idempotent).");
          } else {
            console.log("Work submitted for review.");
          }
          console.log(`Submission: ${result.submission.id}`);
          console.log(`Head commit: ${result.submission.headCommit}`);
          console.log(`Status: ${result.submission.status}`);
        }
      } catch (error) {
        handleRemoteError(error, options.json ?? false);
      }
    });
}
