import { resolvePackageWorkspace } from "../package/loadPackage.js";
import type { PackageWorkspaceRef } from "../types.js";
import { appendRunSessionEvent, updateRunSession } from "./repository.js";
import { withCurrentRunSessionStorage } from "./storageMutation.js";
import type { UpdateRunSessionPatch } from "./types.js";

/** Keep a terminal summary and its audit event indivisible to retention. */
export async function updateRunSessionWithEvent(
  owner: PackageWorkspaceRef,
  sessionId: string,
  patch: UpdateRunSessionPatch,
  type: string,
  data: Record<string, unknown>
) {
  const workspace = await resolvePackageWorkspace(owner);
  return withCurrentRunSessionStorage(workspace, async () => {
    const session = await updateRunSession(workspace, sessionId, patch);
    await appendRunSessionEvent(workspace, sessionId, type, data);
    return session;
  });
}
