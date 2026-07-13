import type { Command } from "commander";
import { getStatus, getDiff, getLog, hasUncommittedChanges, hasStagedChanges, stageAll, commit } from "@planweave-ai/runtime";
import { resolveCliProjectRoot } from "../projectRoot.js";

export function registerGitCommand(program: Command): void {
  const gitCommand = program
    .command("git")
    .description("Git operations for the current PlanWeave project");

  gitCommand
    .command("status")
    .description("Show the working tree status")
    .action(async () => {
      const root = await resolveCliProjectRoot();
      const status = await getStatus(root);
      if (status.clean) {
        console.log(`On branch ${status.branch}, nothing to commit (working tree clean)`);
        return;
      }
      console.log(`Branch: ${status.branch} (ahead ${status.ahead}, behind ${status.behind})`);
      for (const file of status.files) {
        const prefix = file.staged
          ? `  [staged]  ${file.indexStatus}`
          : `  [unstaged] ${file.worktreeStatus}`;
        console.log(`${prefix} ${file.path}`);
      }
    });

  gitCommand
    .command("diff")
    .description("Show changes in the working tree")
    .option("--staged", "show staged changes")
    .action(async (options: { staged?: boolean }) => {
      const root = await resolveCliProjectRoot();
      const diff = await getDiff(root, { staged: options.staged });
      if (diff.hunks.length === 0) {
        console.log("No changes.");
        return;
      }
      for (const hunk of diff.hunks) {
        console.log(hunk.header);
        for (const line of hunk.lines) {
          console.log(line);
        }
      }
    });

  gitCommand
    .command("log")
    .description("Show commit history")
    .option("-n, --max-count <n>", "number of commits to show", "20")
    .action(async (options: { maxCount: string }) => {
      const root = await resolveCliProjectRoot();
      const maxCount = parseInt(options.maxCount, 10) || 20;
      const commits = await getLog(root, { maxCount });
      for (const c of commits) {
        console.log(`${c.abbreviatedHash} ${c.date.slice(0, 10)} ${c.authorName}: ${c.message}`);
      }
    });

  gitCommand
    .command("commit")
    .description("Stage all changes and commit")
    .requiredOption("-m, --message <message>", "commit message")
    .action(async (options: { message: string }) => {
      const root = await resolveCliProjectRoot();
      const hasChanges = await hasUncommittedChanges(root);
      const hasStaged = await hasStagedChanges(root);
      if (!hasChanges && !hasStaged) {
        console.log("Nothing to commit (working tree clean).");
        return;
      }
      await stageAll(root);
      const result = await commit(root, options.message);
      console.log(`Committed: ${result.hash.slice(0, 7)} - ${result.message}`);
    });
}
