import type { Command } from "commander";
import { getProfile } from "../remoteProfile.js";
import { connectRemoteClient, RemoteApiError } from "../remoteClient.js";

export function registerRemoteMergeQueueCommand(program: Command): void {
  program
    .command("merge-queue")
    .description("View remote merge queue status")
    .requiredOption("--profile <name>", "server profile name")
    .option("--json", "print machine-readable output")
    .action(async (options: { profile: string; json?: boolean }) => {
      try {
        const profile = await getProfile(options.profile);
        if (!profile) {
          if (options.json) {
            console.log(JSON.stringify({ kind: "blocked", reason: `Profile '${options.profile}' not found.` }, null, 2));
          } else {
            console.log(`Profile '${options.profile}' not found. Run 'planweave server join' first.`);
          }
          return;
        }
        const client = await connectRemoteClient(profile);
        const status = await client.getMergeQueueStatus();
        if (options.json) {
          console.log(JSON.stringify({ kind: "merge_queue", ...status }, null, 2));
        } else {
          if (status.submissions.length === 0) {
            console.log("Merge queue is empty.");
          } else {
            console.log("Merge queue:");
            for (const sub of status.submissions) {
              console.log(`  ${sub.submissionId} → ${sub.taskId}: ${sub.status} (${sub.headCommit.slice(0, 8)})`);
            }
          }
        }
      } catch (error) {
        if (error instanceof RemoteApiError) {
          if (options.json) {
            console.log(JSON.stringify({ kind: "error", code: error.code, message: error.message }, null, 2));
          } else {
            console.log(`Remote error [${error.code}]: ${error.message}`);
          }
          return;
        }
        if (options.json) {
          console.log(JSON.stringify({ kind: "error", message: error instanceof Error ? error.message : String(error) }, null, 2));
        } else {
          console.log(`Error: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    });
}
