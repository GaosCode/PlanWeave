import type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import type { CollaborationStatus, PlanWeaveCollaborationApi } from "../../shared/collaboration.js";
import { workItemKey } from "../../shared/collaborationReadModels.js";

export type CommentComposerDraft = {
  body: string;
  showPreview: boolean;
};

const emptyDraft: CommentComposerDraft = { body: "", showPreview: false };
const listeners = new Set<() => void>();
const contentVersions = new WeakMap<CommentComposerDraft, object>();
const pendingContents = new WeakSet<object>();

export function subscribeCommentDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notifyDrafts(): void {
  for (const listener of listeners) listener();
}

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

/**
 * Scope drafts to the active collaboration project/auth session.
 * Project switch, disconnect, or auth expiry must clear unsent bodies.
 */
export function setCommentDraftScope(scopeKey: string | null): void {
  if (draftIdentityKey === scopeKey) return;
  draftsByWorkItem.clear();
  draftIdentityKey = scopeKey;
  draftScopeKey = scopeKey === null ? null : `${scopeKey}:${++scopeRevision}`;
  notifyDrafts();
}

export function getCommentDraft(
  workItem: WorkItemRef,
  scopeKey: string | null = draftScopeKey
): CommentComposerDraft {
  if (scopeKey !== draftScopeKey) return emptyDraft;
  const key = workItemKey(workItem);
  return draftsByWorkItem.get(key) ?? emptyDraft;
}

export function setCommentDraft(
  workItem: WorkItemRef,
  patch: Partial<CommentComposerDraft>,
  scopeKey: string | null = draftScopeKey
): CommentComposerDraft {
  const key = workItemKey(workItem);
  if (scopeKey !== draftScopeKey) return emptyDraft;
  const previous = getCommentDraft(workItem, scopeKey);
  const next = { ...previous, ...patch };
  const version =
    patch.body === undefined || patch.body === previous.body
      ? contentVersions.get(previous)
      : undefined;
  contentVersions.set(next, version ?? {});
  draftsByWorkItem.set(key, next);
  notifyDrafts();
  return next;
}

export function clearCommentDraft(
  workItem: WorkItemRef,
  expectedDraft?: CommentComposerDraft,
  scopeKey: string | null = draftScopeKey
): boolean {
  if (scopeKey !== draftScopeKey) return false;
  const key = workItemKey(workItem);
  const current = draftsByWorkItem.get(key);
  if (
    expectedDraft &&
    (!current || contentVersions.get(current) !== contentVersions.get(expectedDraft))
  )
    return false;
  const deleted = draftsByWorkItem.delete(key);
  if (deleted) notifyDrafts();
  return deleted;
}

/** Own submitted content across unmounts; preview changes retain the same content version. */
export function beginCommentDraftSubmission(
  workItem: WorkItemRef,
  draft: CommentComposerDraft,
  scopeKey: string | null
): (() => void) | null {
  const version = contentVersions.get(draft);
  if (
    scopeKey !== draftScopeKey ||
    draftsByWorkItem.get(workItemKey(workItem)) !== draft ||
    !version ||
    pendingContents.has(version)
  )
    return null;
  pendingContents.add(version);
  return () => {
    pendingContents.delete(version);
  };
}

/** Test helper. */
export function resetCommentDraftStoreForTests(): void {
  draftsByWorkItem.clear();
  draftScopeKey = null;
  draftIdentityKey = null;
  draftApi = null;
}
