import * as z from "zod/v4";
import { projectInput } from "./inputShapes.js";
import { readOnlyAnnotations, writeAnnotations, type PlanweavePartialToolDefinitionRegistry } from "./types.js";

export const githubToolDefinitions = {
  git_status: {
    title: "Git Status",
    description: "Return the git working tree status for a PlanWeave project's source directory, including branch, staged/unstaged files, and ahead/behind counts.",
    inputSchema: projectInput,
    annotations: readOnlyAnnotations,
  },
  git_diff: {
    title: "Git Diff",
    description: "Return the git diff (unstaged by default, or staged when staged=true) for a PlanWeave project's source directory.",
    inputSchema: {
      ...projectInput,
      staged: z.boolean().optional(),
      files: z.array(z.string()).optional(),
    },
    annotations: readOnlyAnnotations,
  },
  git_log: {
    title: "Git Log",
    description: "Return recent git commit history for a PlanWeave project's source directory.",
    inputSchema: {
      ...projectInput,
      maxCount: z.number().int().min(1).max(100).optional(),
    },
    annotations: readOnlyAnnotations,
  },
  git_commit: {
    title: "Git Commit",
    description: "Stage all changes and create a git commit with the given message in a PlanWeave project's source directory.",
    inputSchema: {
      ...projectInput,
      message: z.string().min(1),
    },
    annotations: writeAnnotations,
  },
  github_create_pr: {
    title: "Create GitHub Pull Request",
    description: "Create a pull request on GitHub for a PlanWeave project's repository.",
    inputSchema: {
      ...projectInput,
      title: z.string().min(1),
      head: z.string().min(1),
      base: z.string().min(1),
      body: z.string().optional(),
    },
    annotations: writeAnnotations,
  },
  github_list_prs: {
    title: "List GitHub Pull Requests",
    description: "List open pull requests for a PlanWeave project's GitHub repository.",
    inputSchema: {
      ...projectInput,
      state: z.enum(["open", "closed", "all"]).optional(),
    },
    annotations: readOnlyAnnotations,
  },
  github_get_pr: {
    title: "Get GitHub Pull Request",
    description: "Get detailed information about a specific GitHub pull request.",
    inputSchema: {
      ...projectInput,
      prNumber: z.number().int().min(1),
    },
    annotations: readOnlyAnnotations,
  },
  github_merge_pr: {
    title: "Merge GitHub Pull Request",
    description: "Merge a GitHub pull request for a PlanWeave project's repository.",
    inputSchema: {
      ...projectInput,
      prNumber: z.number().int().min(1),
      method: z.enum(["merge", "squash", "rebase"]).optional(),
    },
    annotations: writeAnnotations,
  },
} satisfies PlanweavePartialToolDefinitionRegistry;
