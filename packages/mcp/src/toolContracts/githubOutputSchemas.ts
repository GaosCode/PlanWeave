import * as z from "zod/v4";
import type { PlanweavePartialToolOutputSchemaRegistry } from "./types.js";

const fileStatusSchema = z.object({
  path: z.string(),
  indexStatus: z.string(),
  worktreeStatus: z.string(),
  staged: z.boolean(),
});

const gitStatusSchema = z.object({
  branch: z.string(),
  ahead: z.number(),
  behind: z.number(),
  files: z.array(fileStatusSchema),
  clean: z.boolean(),
});

const gitDiffHunkSchema = z.object({
  header: z.string(),
  lines: z.array(z.string()),
});

const gitDiffResultSchema = z.object({
  hunks: z.array(gitDiffHunkSchema),
  raw: z.string(),
});

const gitCommitSchema = z.object({
  hash: z.string(),
  abbreviatedHash: z.string(),
  message: z.string(),
  authorName: z.string(),
  authorEmail: z.string(),
  date: z.string(),
});

const gitRepoInfoSchema = z.object({
  owner: z.string().nullable(),
  repo: z.string().nullable(),
  remotes: z.array(z.object({
    name: z.string(),
    fetchUrl: z.string(),
    pushUrl: z.string(),
  })),
  defaultRemote: z.string().nullable(),
});

const gitCommitResultSchema = z.object({
  hash: z.string(),
  message: z.string(),
});

const githubPRSchema = z.object({
  number: z.number(),
  title: z.string(),
  state: z.string(),
  htmlUrl: z.string(),
  headBranch: z.string(),
  baseBranch: z.string(),
  author: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  draft: z.boolean(),
  mergeable: z.boolean().nullable(),
});

export const githubToolOutputSchemas = {
  git_status: { status: gitStatusSchema },
  git_diff: { diff: gitDiffResultSchema },
  git_log: { commits: z.array(gitCommitSchema) },
  git_commit: { commit: gitCommitResultSchema },
  github_create_pr: { pr: githubPRSchema },
  github_list_prs: { prs: z.array(githubPRSchema) },
  github_get_pr: { pr: githubPRSchema },
  github_merge_pr: { merge: z.object({
      merged: z.boolean(),
      message: z.string(),
    })
  },
} satisfies PlanweavePartialToolOutputSchemaRegistry;
