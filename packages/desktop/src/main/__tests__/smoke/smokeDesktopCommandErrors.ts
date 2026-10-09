import type { BrowserWindow } from "electron";

/** Exercise actual Server CAS failures through main, preload and native contextBridge. */
export function runDesktopCommandErrorsSmoke(window: BrowserWindow): Promise<unknown> {
  return window.webContents.executeJavaScript(`
    (async () => {
      const api = window.planweaveCollaboration;
      if (!api) throw new Error("Collaboration bridge unavailable for failure smoke.");
      const projects = await window.planweave.listProjects();
      const project = projects.find((item) => item.projectId && item.activeCanvasId);
      if (!project) throw new Error("Local smoke canvas unavailable.");
      const workItem = { kind: "block", canvasId: project.activeCanvasId, blockRef: "T-001#B-001" };
      const self = await api.getWorkspaceConnectionSelf();
      const principal = { kind: "human", humanPrincipalId: self.humanPrincipalId };
      const results = [];
      for (const role of ["responsibility", "reviewer"]) {
        const before = await api.getCollaborationWorkAuthority({ workItem });
        const update = role === "responsibility"
          ? api.updateCollaborationResponsibility
          : api.updateCollaborationReviewer;
        const expectedRevision = before[role].revision;
        await update({ workItem, principal, expectedRevision });
        const after = await api.getCollaborationWorkAuthority({ workItem });
        if (after[role].revision <= expectedRevision) {
          throw new Error(role + " CAS success did not advance authority.");
        }
        let failure;
        try {
          await update({ workItem, principal: null, expectedRevision });
        } catch (error) {
          failure = error;
        }
        if (!failure || failure.kind !== "conflict" ||
            failure.code !== "authority_revision_conflict" || failure.httpStatus !== 409 ||
            typeof failure.retryable !== "boolean" || typeof failure.message !== "string") {
          throw new Error(role + " contextBridge lost the classified CAS failure.");
        }
        const rejected = await api.getCollaborationWorkAuthority({ workItem });
        if (rejected[role].revision !== after[role].revision ||
            rejected[role].principal?.humanPrincipalId !== principal.humanPrincipalId) {
          throw new Error(role + " stale CAS altered authority.");
        }
        results.push({ role, kind: failure.kind, code: failure.code,
          httpStatus: failure.httpStatus, revision: rejected[role].revision });
      }
      return results;
    })()
  `);
}
