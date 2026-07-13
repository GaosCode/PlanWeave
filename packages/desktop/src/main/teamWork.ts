import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { LocalTaskValidation, RemoteAssignment } from "../shared/remoteTypes.js";
import type { RemoteProfileWithCredentials } from "./remoteProfiles.js";
import { DesktopSettingsStore } from "./desktopSettingsStore.js";
import { detectAgentTools, runAgentPrompt } from "./agentTools.js";
import { createRemoteBaseline, createRemoteTask, decideRemoteMerge, getRemoteAssignments, getRemoteAttachmentBytes, getRemoteAttachments, getRemoteCoordination, getRemoteMergeQueue, getRemoteMessages, getRemotePlanningRooms, getRemoteTasks, postRemoteAgentReview, submitRemoteAssignmentEvidence, uploadRemoteSubmissionBundle } from "./remoteClient.js";

const execFile = promisify(execFileCallback);
const unsafeCommandCharacters = /[;&|`$<>\n\r]/;

async function git(repositoryPath: string, ...args: string[]): Promise<string> {
  const result = await execFile("git", ["-C", resolve(repositoryPath), ...args], { encoding: "utf8", timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
  return result.stdout.trim();
}

export async function repositoryHead(repositoryPath: string): Promise<string> {
  await git(repositoryPath, "rev-parse", "--is-inside-work-tree");
  return git(repositoryPath, "rev-parse", "HEAD");
}

async function selectedAgent() {
  const settings = await new DesktopSettingsStore().read();
  const detections = await detectAgentTools();
  const detection = detections.find((item) => item.installed && settings.agents[item.kind]?.enabled);
  if (!detection) throw new Error("请先在 PlanWeave 设置中启用一个已安装的 Agent（Codex、Claude Code、OpenCode 或 Pi）");
  return { detection, fullAccess: settings.agents[detection.kind]?.fullAccess === true };
}

function parseAgentJson(output: string): Record<string, unknown> {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1);
  try { const parsed = JSON.parse(candidate) as unknown; if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>; } catch { /* handled below */ }
  throw new Error("Agent 没有返回可解析的结构化 JSON，请重试或先完善讨论内容");
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [];
}

export async function generateConsensusBaselineWithAgent(profile: RemoteProfileWithCredentials, projectId: string, repositoryPath: string): Promise<unknown> {
  const rooms = await getRemotePlanningRooms(profile, projectId);
  const [messageGroups, attachments] = await Promise.all([Promise.all(rooms.map((room) => getRemoteMessages(profile, projectId, room.id))), getRemoteAttachments(profile, projectId)]);
  const messages = messageGroups.flat();
  if (messages.length === 0 && attachments.length === 0) throw new Error("规划室还没有讨论或附件，无法生成有效需求看板");
  const attachmentInputs = await Promise.all(attachments.map(async (attachment) => {
    const textual = attachment.mediaType.startsWith("text/") || /json|xml|yaml|markdown/.test(attachment.mediaType);
    let content: string | undefined;
    if (textual && attachment.size <= 1024 * 1024) content = new TextDecoder("utf-8", { fatal: false }).decode(await getRemoteAttachmentBytes(profile, projectId, attachment.id)).slice(0, 200_000);
    return { id: attachment.id, name: attachment.originalName, mediaType: attachment.mediaType, size: attachment.size, digest: attachment.digest, ...(content ? { content } : { note: "二进制或过大文件，仅引用元数据；需要成员在讨论中补充关键结论" }) };
  }));
  const { detection } = await selectedAgent();
  const prompt = `你是 PlanWeave Host 的需求协调 Agent。根据局域网团队讨论和附件生成一份可冻结的一致看板。保留尚未解决的问题，不要自行替团队拍板。无法读取的附件必须形成开放问题，不能猜测。只输出 JSON，不要 Markdown。结构必须是：{"title":string,"summary":string,"requirements":string[],"constraints":string[],"decisions":string[],"acceptanceCriteria":string[],"risks":string[],"openQuestions":string[]}。每项要可验证、无重复。\n讨论记录：\n${JSON.stringify(messages.map((message) => ({ id: message.id, author: message.authorUserId, body: message.body, createdAt: message.createdAt })))}\n附件：\n${JSON.stringify(attachmentInputs)}`;
  const result = await runAgentPrompt({ kind: detection.kind, cwd: resolve(repositoryPath), prompt, fullAccess: false });
  const parsed = parseAgentJson(result.output);
  return createRemoteBaseline(profile, projectId, { title: typeof parsed.title === "string" ? parsed.title : "团队一致看板", summary: typeof parsed.summary === "string" ? parsed.summary : "", requirements: stringArray(parsed.requirements), constraints: stringArray(parsed.constraints), decisions: stringArray(parsed.decisions), acceptanceCriteria: stringArray(parsed.acceptanceCriteria), risks: stringArray(parsed.risks), openQuestions: stringArray(parsed.openQuestions), citations: [...messages.map((message) => ({ kind: "message" as const, id: message.id })), ...attachments.map((attachment) => ({ kind: "attachment" as const, id: attachment.id }))] });
}

export async function generateTaskGraphWithAgent(profile: RemoteProfileWithCredentials, projectId: string, repositoryPath: string): Promise<unknown[]> {
  const coordination = await getRemoteCoordination(profile, projectId);
  const baseline = coordination.baselines.find((item) => item.id === coordination.activeBaselineId);
  if (!baseline || baseline.status !== "frozen") throw new Error("必须先全员通过并冻结一致看板");
  const existing = await getRemoteTasks(profile, projectId);
  if (existing.length > 0) throw new Error("流程图已经有任务；为避免重复拆分，请先使用现有任务或开启新的看板修订");
  const { detection } = await selectedAgent();
  const prompt = `你是 PlanWeave Host 的任务拆分 Agent。基于已冻结看板把实现拆成可独立领取、可验收、依赖无环的任务。只输出 JSON，不要 Markdown。结构：{"tasks":[{"taskId":string,"title":string,"description":string,"requirementIds":string[],"dependencyIds":string[],"parallel":boolean,"locks":string[],"ownershipScopes":string[],"acceptanceChecks":string[],"reviewers":string[]}]}。taskId 仅用小写字母数字和短横线；dependencyIds 只能引用列表中更早出现的 taskId；命令不得含 shell 操作符。\n冻结看板：${JSON.stringify(baseline)}`;
  const result = await runAgentPrompt({ kind: detection.kind, cwd: resolve(repositoryPath), prompt, fullAccess: false });
  const parsed = parseAgentJson(result.output);
  if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0 || parsed.tasks.length > 100) throw new Error("Agent 没有生成有效任务列表");
  const created: unknown[] = [];
  const known = new Set<string>();
  for (const value of parsed.tasks) {
    if (typeof value !== "object" || value === null) throw new Error("Agent 任务格式无效");
    const task = value as Record<string, unknown>; const taskId = typeof task.taskId === "string" ? task.taskId.trim() : "";
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(taskId) || known.has(taskId)) throw new Error(`Agent 生成了无效或重复的 taskId: ${taskId}`);
    const dependencyIds = stringArray(task.dependencyIds); if (dependencyIds.some((id) => !known.has(id))) throw new Error(`任务 ${taskId} 引用了尚未创建的依赖`);
    const acceptanceChecks = stringArray(task.acceptanceChecks); if (acceptanceChecks.some((command) => unsafeCommandCharacters.test(command))) throw new Error(`任务 ${taskId} 的验收命令包含不安全字符`);
    const ownershipScopes = stringArray(task.ownershipScopes); if (ownershipScopes.length === 0) throw new Error(`任务 ${taskId} 没有明确的文件所有权范围`);
    created.push(await createRemoteTask(profile, projectId, { taskId, title: typeof task.title === "string" ? task.title : taskId, description: typeof task.description === "string" ? task.description : "", baselineId: baseline.id, requirementIds: stringArray(task.requirementIds), dependencyIds, parallel: task.parallel === true, locks: stringArray(task.locks), ownershipScopes, acceptanceChecks, reviewers: stringArray(task.reviewers) }));
    known.add(taskId);
  }
  return created;
}

async function runAcceptanceCheck(repositoryPath: string, command: string): Promise<{ name: string; passed: boolean; output?: string }> {
  const trimmed = command.trim();
  if (!trimmed || unsafeCommandCharacters.test(trimmed)) return { name: trimmed || "invalid check", passed: false, output: "Blocked: acceptance checks may not contain shell operators" };
  const argv = trimmed.split(/\s+/);
  const executable = argv.shift()!;
  if (!["pnpm", "npm", "yarn", "node", "git", "cargo", "go"].includes(executable)) return { name: trimmed, passed: false, output: `Blocked executable: ${executable}` };
  try {
    const result = await execFile(executable, argv, { cwd: resolve(repositoryPath), encoding: "utf8", timeout: 10 * 60_000, maxBuffer: 2 * 1024 * 1024 });
    return { name: trimmed, passed: true, output: `${result.stdout}${result.stderr}`.trim().slice(-20_000) };
  } catch (error) {
    const detail = error && typeof error === "object" ? `${"stdout" in error ? String(error.stdout) : ""}${"stderr" in error ? String(error.stderr) : ""}` : String(error);
    return { name: trimmed, passed: false, output: detail.trim().slice(-20_000) };
  }
}

function findAssignment(assignments: RemoteAssignment[], assignmentId: string): RemoteAssignment {
  const assignment = assignments.find((item) => item.id === assignmentId);
  if (!assignment) throw new Error("当前用户没有这个任务的有效分配");
  if (assignment.status !== "active") throw new Error(`任务分配当前为 ${assignment.status}，不能提交`);
  return assignment;
}

export async function validateAssignmentLocally(profile: RemoteProfileWithCredentials, projectId: string, assignmentId: string, repositoryPath: string): Promise<LocalTaskValidation> {
  const [assignments, tasks, coordination] = await Promise.all([getRemoteAssignments(profile, projectId), getRemoteTasks(profile, projectId), getRemoteCoordination(profile, projectId)]);
  const assignment = findAssignment(assignments, assignmentId);
  const task = tasks.find((item) => item.taskId === assignment.taskId);
  if (!task) throw new Error("任务定义不再存在");
  const headCommit = await repositoryHead(repositoryPath);
  const baseCommit = assignment.baseCommit;
  if (!/^[0-9a-f]{40,64}$/.test(baseCommit)) throw new Error("任务领取时没有记录不可变的 Git 基线，请重新领取任务");
  await git(repositoryPath, "merge-base", "--is-ancestor", baseCommit, headCommit);
  const changedFiles = (await git(repositoryPath, "diff", "--name-only", `${baseCommit}..${headCommit}`)).split(/\r?\n/).filter(Boolean);
  if (changedFiles.length === 0) throw new Error("当前分支相对任务基线没有可提交的改动");
  const localChecks = [];
  for (const check of task.policy.acceptanceChecks) localChecks.push(await runAcceptanceCheck(repositoryPath, check));
  if (localChecks.length === 0) localChecks.push({ name: "git diff contains changes", passed: true, output: changedFiles.join("\n") });
  const { detection } = await selectedAgent();
  const activeBaseline = coordination.baselines.find((item) => item.id === task.baselineId) ?? coordination.baselines.find((item) => item.id === coordination.activeBaselineId);
  const diffStat = await git(repositoryPath, "diff", "--stat", `${baseCommit}..${headCommit}`);
  const prompt = `你是 PlanWeave 成员端的只读验收 Agent。禁止修改任何文件。请判断本地实现是否满足已冻结看板与所领取流程节点，只报告事实、缺口和最终结论。\n\n任务：${task.title}\n任务说明：${task.description ?? ""}\n需求映射：${(task.requirementIds ?? []).join(", ")}\n所有权范围：${task.policy.ownershipScopes.join(", ")}\n验收命令：${task.policy.acceptanceChecks.join("; ")}\n冻结看板：${activeBaseline ? JSON.stringify(activeBaseline) : "未找到"}\n变更文件：${changedFiles.join(", ")}\nDiff 统计：\n${diffStat}\n本地检查：${JSON.stringify(localChecks)}\n\n最后一行必须严格输出 PLANWEAVE_VERDICT: APPROVE 或 PLANWEAVE_VERDICT: REJECT。`;
  const result = await runAgentPrompt({ kind: detection.kind, cwd: resolve(repositoryPath), prompt, fullAccess: false });
  const agentApproved = /PLANWEAVE_VERDICT:\s*APPROVE\s*$/im.test(result.output);
  return { assignmentId, headCommit, baseCommit, localChecks, agentKind: detection.kind, agentVersion: result.version, agentReport: result.output, passed: localChecks.every((item) => item.passed) && agentApproved };
}

export async function submitAssignment(profile: RemoteProfileWithCredentials, projectId: string, assignmentId: string, repositoryPath: string, validation: LocalTaskValidation): Promise<unknown> {
  if (validation.assignmentId !== assignmentId || !validation.passed) throw new Error("本地检查或 Agent 验收尚未通过");
  const assignment = findAssignment(await getRemoteAssignments(profile, projectId), assignmentId);
  const currentHead = await repositoryHead(repositoryPath);
  if (currentHead !== validation.headCommit || assignment.baseCommit !== validation.baseCommit) throw new Error("验证后 Git HEAD 或任务基线发生变化，请重新检查");
  const submitted = await submitRemoteAssignmentEvidence(profile, projectId, assignmentId, { expectedVersion: assignment.version, headCommit: currentHead, baseCommit: assignment.baseCommit, localChecks: validation.localChecks, agentReport: validation.agentReport });
  const root = await mkdtemp(join(tmpdir(), "planweave-submit-"));
  const bundlePath = join(root, `${submitted.submission.id}.bundle`);
  try {
    await git(repositoryPath, "bundle", "create", bundlePath, currentHead, `^${assignment.baseCommit}`);
    return await uploadRemoteSubmissionBundle(profile, projectId, submitted.submission.id, bundlePath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function reviewMergeWithHostAgent(profile: RemoteProfileWithCredentials, projectId: string, entryId: string, decision: "approve" | "reject", repositoryPath: string, bareRepoPath: string): Promise<unknown> {
  const queue = await getRemoteMergeQueue(profile, projectId);
  const entry = queue.submissions.find((item) => item.entryId === entryId);
  if (!entry) throw new Error("合并队列条目不存在");
  if (entry.status !== "reviewing") throw new Error(`合并条目当前为 ${entry.status}，不在审查阶段`);
  const { detection } = await selectedAgent();
  const diff = await execFile("git", ["--git-dir", bareRepoPath, "diff", "--stat", `${entry.baseCommit}..${entry.headCommit}`], { encoding: "utf8", timeout: 120_000, maxBuffer: 2 * 1024 * 1024 }).then((result) => result.stdout.trim());
  const result = await runAgentPrompt({ kind: detection.kind, cwd: resolve(repositoryPath), fullAccess: false, prompt: `你是 PlanWeave Host 的最终只读审查 Agent。禁止修改文件。根据 Host 检查日志与提交差异判断是否可合并。\n检查日志：${JSON.stringify(entry.checkLogs)}\nDiff 统计：${diff}\n最后一行必须严格输出 PLANWEAVE_VERDICT: APPROVE 或 PLANWEAVE_VERDICT: REJECT。` });
  const verdict = /PLANWEAVE_VERDICT:\s*APPROVE\s*$/im.test(result.output) ? "approve" : "reject";
  await postRemoteAgentReview(profile, projectId, entryId, verdict, result.output);
  if (decision === "approve" && verdict !== "approve") throw new Error("Host Agent 拒绝了这次提交，不能人工批准合并");
  return decideRemoteMerge(profile, projectId, entryId, decision);
}
