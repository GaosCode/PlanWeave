import type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import { workItemKey } from "../../shared/collaborationReadModels.js";

export type CommentComposerDraft = {
  body: string;
  showPreview: boolean;
};

const draftsByWorkItem = new Map<string, CommentComposerDraft>();
let draftScopeKey: string | null = null;

function emptyDraft(): CommentComposerDraft {
  return { body: "", showPreview: false };
}

/**
 * Scope drafts to the active collaboration project/auth session.
 * Project switch, disconnect, or auth expiry must clear unsent bodies.
 */
export function setCommentDraftScope(scopeKey: string | null): void {
  if (draftScopeKey === scopeKey) return;
  draftsByWorkItem.clear();
  draftScopeKey = scopeKey;
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
}
