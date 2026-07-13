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
          const subs = status.submissions;
          if (subs.length === 0) {
            console.log("Merge queue is empty.");
          } else {
            const statusCounts: Record<string, number> = {};
            for (const sub of subs) {
              statusCounts[sub.status] = (statusCounts[sub.status] ?? 0) + 1;
            }
            const summary = Object.entries(statusCounts)
              .map(([s, c]) => `${c} ${s}`)
              .join(", ");
            console.log(`Merge queue (${subs.length} entries: ${summary}):`);
            console.log("");
            for (let i = 0; i < subs.length; i++) {
              const sub = subs[i];
              const pos = `#${i + 1}`.padEnd(4);
              const statusIcon = sub.status === "merged" ? "M" : sub.status === "checking" ? "C" : sub.status === "failed" ? "F" : sub.status === "conflict" ? "!" : sub.status === "reviewing" ? "R" : "P";
              const shortHead = sub.headCommit.slice(0, 8);
              const shortBase = sub.baseCommit.slice(0, 8);
              console.log(`  ${pos} [${statusIcon}] ${sub.submissionId} → ${sub.taskId}`);
              console.log(`        head: ${shortHead}  base: ${shortBase}  status: ${sub.status}`);
              if (sub.createdAt) {
                const age = timeAgo(new Date(sub.createdAt));
                console.log(`        queued: ${age} ago`);
              }
              if (i < subs.length - 1) console.log("");
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

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
