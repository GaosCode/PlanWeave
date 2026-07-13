import { jsonToolResult, parseProjectArgs, readObjectArgs } from "../toolHelpers.js";
import type { PlanweavePartialToolHandlerRegistry } from "../toolDispatcher.js";
import type { RuntimeGateway } from "../toolTypes.js";

export const githubToolHandlers = {
  git_status: async (args, gateway) => {
    const { projectId } = parseProjectArgs(args);
    return jsonToolResult({ status: await gateway.gitStatus(projectId) });
  },

  git_diff: async (args, gateway) => {
    const { projectId } = parseProjectArgs(args);
    const record = readObjectArgs(args);
    const staged = typeof record.staged === "boolean" ? record.staged : undefined;
    const files = Array.isArray(record.files) ? record.files.filter((f: unknown): f is string => typeof f === "string") : undefined;
    return jsonToolResult({ diff: await gateway.gitDiff(projectId, staged, files) });
  },

  git_log: async (args, gateway) => {
    const { projectId } = parseProjectArgs(args);
    const record = readObjectArgs(args);
    const maxCount = typeof record.maxCount === "number" ? record.maxCount : undefined;
    return jsonToolResult({ commits: await gateway.gitLog(projectId, maxCount) });
  },

  git_commit: async (args, gateway) => {
    const { projectId } = parseProjectArgs(args);
    const record = readObjectArgs(args);
    const message = typeof record.message === "string" && record.message.trim()
      ? record.message.trim()
      : "";
    if (!message) {
      throw new Error("commit message is required");
    }
    return jsonToolResult({ commit: await gateway.gitCommit(projectId, message) });
  },

  github_create_pr: async (args, gateway) => {
    const { projectId } = parseProjectArgs(args);
    const record = readObjectArgs(args);
    const title = typeof record.title === "string" && record.title.trim() ? record.title.trim() : "";
    const head = typeof record.head === "string" && record.head.trim() ? record.head.trim() : "";
    const base = typeof record.base === "string" && record.base.trim() ? record.base.trim() : "";
    const body = typeof record.body === "string" ? record.body : undefined;
    if (!title) throw new Error("PR title is required");
    if (!head) throw new Error("head branch is required");
    if (!base) throw new Error("base branch is required");
    return jsonToolResult({ pr: await gateway.githubCreatePR(projectId, title, head, base, body) });
  },

  github_list_prs: async (args, gateway) => {
    const { projectId } = parseProjectArgs(args);
    const record = readObjectArgs(args);
    const state = typeof record.state === "string"
      ? (record.state as "open" | "closed" | "all")
      : undefined;
    return jsonToolResult({ prs: await gateway.githubListPRs(projectId, state) });
  },

  github_get_pr: async (args, gateway) => {
    const { projectId } = parseProjectArgs(args);
    const record = readObjectArgs(args);
    const prNumber = typeof record.prNumber === "number" ? record.prNumber : 0;
    if (!prNumber || prNumber < 1) throw new Error("prNumber is required (positive integer)");
    return jsonToolResult({ pr: await gateway.githubGetPR(projectId, prNumber) });
  },

  github_merge_pr: async (args, gateway) => {
    const { projectId } = parseProjectArgs(args);
    const record = readObjectArgs(args);
    const prNumber = typeof record.prNumber === "number" ? record.prNumber : 0;
    const method = record.method === "squash" || record.method === "rebase" || record.method === "merge" ? record.method : undefined;
    if (!prNumber || prNumber < 1) throw new Error("prNumber is required (positive integer)");
    return jsonToolResult({ merge: await gateway.githubMergePR(projectId, prNumber, method) });
  },
} satisfies PlanweavePartialToolHandlerRegistry;
