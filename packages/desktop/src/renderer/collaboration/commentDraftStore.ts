import type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import type { CollaborationStatus, PlanWeaveCollaborationApi } from "../../shared/collaboration.js";
import { workItemKey } from "../../shared/collaborationReadModels.js";

export type CommentComposerDraft = {
  body: string;
  showPreview: boolean;
};

const draftsByWorkItem = new Map<string, CommentComposerDraft>();
let draftScopeKey: string | null = null;
let draftIdentityKey: string | null = null;
let scopeRevision = 0;
let draftApi: PlanWeaveCollaborationApi | null = null;
let draftApiActivation = 0;
const apiIds = new WeakMap<PlanWeaveCollaborationApi, number>();
let nextApiId = 0;

export function activateCommentDraftApi(api: PlanWeaveCollaborationApi): number {
  if (draftApi === api) return draftApiActivation;
  draftApi = api;
  if (!apiIds.has(api)) apiIds.set(api, ++nextApiId);
  setCommentDraftScope(null);
  return ++draftApiActivation;
}

export function getCommentDraftApiActivation(api: PlanWeaveCollaborationApi): number | null {
  return draftApi === api ? draftApiActivation : null;
}

export function deactivateCommentDraftApi(api: PlanWeaveCollaborationApi): void {
  if (draftApi !== api) return;
  setCommentDraftScope(null);
  draftApi = null;
}

export function getCommentDraftScope(api: PlanWeaveCollaborationApi): string | null {
  return draftApi === api ? draftScopeKey : null;
}

/** Only confirmed status changes retire drafts; loading and read failures do not. */
export function updateCommentDraftStatus(
  api: PlanWeaveCollaborationApi,
  status: CollaborationStatus
): string | null {
  if (draftApi !== api) return null;
  const profile = status.profiles.find((item) => item.profileId === status.activeProfileId);
  const scope =
    status.session.phase === "connected" &&
    status.session.operationScope &&
    profile?.hasDeviceCredential
      ? JSON.stringify([
          apiIds.get(api),
          status.session.operationScope.sessionId,
          profile.profileId,
          profile.projectId,
          profile.serverBaseUrl,
          profile.humanPrincipalId,
          profile.deviceCredentialId,
          profile.credentialRevision,
          status.session.activeProfileId,
          status.workspaceConnection.workspaceId,
          status.workspaceConnection.credentialRevision
        ])
      : null;
  setCommentDraftScope(scope);
  return draftScopeKey;
}

function emptyDraft(): CommentComposerDraft {
  return { body: "", showPreview: false };
}

/**
 * Scope drafts to the active collaboration project/auth session.
 * Project switch, disconnect, or auth expiry must clear unsent bodies.
 */
export function setCommentDraftScope(scopeKey: string | null): void {
  if (draftIdentityKey === scopeKey) return;
  draftsByWorkItem.clear();
  draftIdentityKey = scopeKey;
  draftScopeKey = scopeKey === null ? null : `${scopeKey}:${++scopeRevision}`;
}

export function getCommentDraft(
  workItem: WorkItemRef,
  scopeKey: string | null = draftScopeKey
): CommentComposerDraft {
  if (scopeKey !== draftScopeKey) return emptyDraft();
  const key = workItemKey(workItem);
  return draftsByWorkItem.get(key) ?? emptyDraft();
}

export function setCommentDraft(
  workItem: WorkItemRef,
  patch: Partial<CommentComposerDraft>,
  scopeKey: string | null = draftScopeKey
): CommentComposerDraft {
  const key = workItemKey(workItem);
  if (scopeKey !== draftScopeKey) return emptyDraft();
  const next = { ...getCommentDraft(workItem, scopeKey), ...patch };
  draftsByWorkItem.set(key, next);
  return next;
}

export function clearCommentDraft(
  workItem: WorkItemRef,
  expectedDraft?: CommentComposerDraft,
  scopeKey: string | null = draftScopeKey
): boolean {
  if (scopeKey !== draftScopeKey) return false;
  const key = workItemKey(workItem);
  if (expectedDraft && draftsByWorkItem.get(key) !== expectedDraft) return false;
  return draftsByWorkItem.delete(key);
}

/** Test helper. */
export function resetCommentDraftStoreForTests(): void {
  draftsByWorkItem.clear();
  draftScopeKey = null;
  draftIdentityKey = null;
  draftApi = null;
}
