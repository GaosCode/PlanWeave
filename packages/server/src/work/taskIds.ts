export function serverTaskId(projectId: string, taskId: string): string {
  return `task_${Buffer.from(projectId, "utf8").toString("base64url")}_${Buffer.from(taskId, "utf8").toString("base64url")}`
}
