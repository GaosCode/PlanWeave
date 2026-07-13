import type { Command } from "commander";
import { getRepoInfo } from "@planweave-ai/runtime";
import { createPR, listPRs, getPR, mergePR } from "@planweave-ai/mcp/github";
import { resolveToken, getTokenStatus, saveAuthStore, clearAuthStore } from "@planweave-ai/mcp/github";
import { resolveCliProjectRoot } from "../projectRoot.js";
import { createInterface } from "node:readline/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function resolveOwnerRepo(): Promise<{ owner: string; repo: string; root: string }> {
  const root = await resolveCliProjectRoot();
  const info = await getRepoInfo(root);
  if (!info.owner || !info.repo) {
    throw new Error(
      "This project is not linked to a GitHub repository. Ensure a git remote named 'origin' points to github.com.",
    );
  }
  return { owner: info.owner, repo: info.repo, root };
}

export function registerGitHubCommand(program: Command): void {
  const ghCommand = program
    .command("gh")
    .description("GitHub operations for the current PlanWeave project");

  ghCommand
    .command("login")
    .description("Authenticate with GitHub")
    .action(async () => {
      const status = await getTokenStatus();
      if (status.authenticated) {
        console.log(`Already authenticated as ${status.login} (source: ${status.source})`);
        return;
      }

      console.log("Opening browser to create a GitHub Personal Access Token...");
      console.log("URL: https://github.com/settings/tokens/new?scopes=repo&description=PlanWeave");

      try {
        await execFileAsync("open", [
          "https://github.com/settings/tokens/new?scopes=repo&description=PlanWeave",
        ]);
      } catch {
        // Non-macOS or missing `open` command — browser URL is already printed
      }

      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const token = (await rl.question("Paste your token: ")).trim();
      rl.close();

      if (!token) {
        console.log("No token provided. Aborted.");
        return;
      }

      try {
        const response = await fetch("https://api.github.com/user", {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "PlanWeave",
          },
        });

        if (!response.ok) {
          console.log("Invalid token. Please check the token and try again.");
          return;
        }

        const user = (await response.json()) as { login: string };
        const scopesHeader = response.headers.get("X-OAuth-Scopes");
        const scopes = scopesHeader ? scopesHeader.split(",").map((s) => s.trim()) : [];

        await saveAuthStore({
          token,
          login: user.login,
          scopes,
          createdAt: new Date().toISOString(),
        });

        console.log(`Authenticated as ${user.login}`);
        console.log(`Scopes: ${scopes.join(", ") || "none"}`);
        console.log("Token saved to ~/.planweave/github-auth.json");
      } catch (error) {
        console.log(`Authentication failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

  ghCommand
    .command("logout")
    .description("Remove saved GitHub token")
    .action(async () => {
      await clearAuthStore();
      console.log("GitHub token removed from ~/.planweave/github-auth.json");
    });

  ghCommand
    .command("status")
    .description("Show GitHub authentication status")
    .action(async () => {
      const status = await getTokenStatus();
      if (!status.authenticated) {
        console.log("Not authenticated with GitHub.");
        console.log("Run 'planweave gh login' to authenticate.");
        return;
      }
      console.log(`Authenticated: ${status.authenticated}`);
      console.log(`Login: ${status.login}`);
      console.log(`Source: ${status.source}`);
      console.log(`Scopes: ${status.scopes.join(", ") || "none"}`);
    });

  const prCommand = ghCommand
    .command("pr")
    .description("Pull request operations");

  prCommand
    .command("create")
    .description("Create a pull request")
    .requiredOption("-t, --title <title>", "PR title")
    .requiredOption("--head <branch>", "head branch")
    .requiredOption("--base <branch>", "base branch (default: main)", "main")
    .option("-b, --body <body>", "PR description")
    .action(async (options: { title: string; head: string; base: string; body?: string }) => {
      const { owner, repo } = await resolveOwnerRepo();
      const pr = await createPR(owner, repo, {
        title: options.title,
        head: options.head,
        base: options.base,
        body: options.body,
      });
      console.log(`Created PR #${pr.number}: ${pr.title}`);
      console.log(pr.htmlUrl);
    });

  prCommand
    .command("list")
    .description("List pull requests")
    .option("-s, --state <state>", "filter by state (open|closed|all)", "open")
    .action(async (options: { state: string }) => {
      const { owner, repo } = await resolveOwnerRepo();
      const prs = await listPRs(owner, repo, { state: options.state as "open" | "closed" | "all" });
      if (prs.length === 0) {
        console.log("No pull requests found.");
        return;
      }
      for (const pr of prs) {
        const stateLabel = pr.draft ? " [DRAFT]" : "";
        console.log(`#${pr.number}${stateLabel} ${pr.title} (${pr.headBranch} -> ${pr.baseBranch}) by ${pr.author}`);
      }
    });

  prCommand
    .command("view")
    .description("View a pull request")
    .argument("<number>", "PR number")
    .action(async (prNumber: string) => {
      const { owner, repo } = await resolveOwnerRepo();
      const pr = await getPR(owner, repo, parseInt(prNumber, 10));
      console.log(`#${pr.number}: ${pr.title}`);
      console.log(`State: ${pr.state}${pr.draft ? " (DRAFT)" : ""}`);
      console.log(`Author: ${pr.author}`);
      console.log(`Branch: ${pr.headBranch} -> ${pr.baseBranch}`);
      console.log(`Changes: +${pr.additions} -${pr.deletions} (${pr.changedFiles} files)`);
      console.log(`URL: ${pr.htmlUrl}`);
      if (pr.body) {
        console.log(`\n${pr.body}`);
      }
    });

  prCommand
    .command("merge")
    .description("Merge a pull request")
    .argument("<number>", "PR number")
    .option("--squash", "squash merge", false)
    .option("--rebase", "rebase merge", false)
    .action(async (prNumber: string, options: { squash?: boolean; rebase?: boolean }) => {
      const { owner, repo } = await resolveOwnerRepo();
      const method = options.squash ? "squash" : options.rebase ? "rebase" : "merge";
      const result = await mergePR(owner, repo, parseInt(prNumber, 10), { method: method as "merge" | "squash" | "rebase" });
      console.log(result.merged ? `PR #${prNumber} merged successfully.` : `Failed to merge PR #${prNumber}: ${result.message}`);
    });
}
