import { withCurrentProjectWorkspace } from "../project.js";
import { assertCurrentCanvasWorkspace } from "../package/assertCurrentCanvasWorkspace.js";
import { assertResultsStorageIdentity } from "../package/packageStorageIdentity.js";
import { withCanvasStorageMutation } from "../package/withCanvasStorageMutation.js";
import type { ProjectWorkspace } from "../types.js";

/** Admit a captured session owner before any result or state mutation. */
export function withCurrentRunSessionStorage<T>(
  workspace: ProjectWorkspace,
  action: () => Promise<T>
): Promise<T> {
  return withCurrentProjectWorkspace(workspace, () =>
    withCanvasStorageMutation(workspace, async () => {
      await assertCurrentCanvasWorkspace(workspace);
      await assertResultsStorageIdentity(workspace);
      return action();
    })
  );
}
