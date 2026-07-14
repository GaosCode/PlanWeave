import { executeTaskWorkspaceRetry } from "./taskWorkspaceRetry.js";
import {
  taskWorkspaceRetryIdentitySchema,
  type TaskWorkspaceRetryIdentity
} from "./types/taskWorkspaceTypes.js";

export function retryTaskWorkspaceRun(rawIdentity: TaskWorkspaceRetryIdentity) {
  return executeTaskWorkspaceRetry(taskWorkspaceRetryIdentitySchema.parse(rawIdentity));
}
