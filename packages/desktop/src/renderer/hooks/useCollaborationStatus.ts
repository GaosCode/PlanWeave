import { useEffect, useRef, useSyncExternalStore } from "react";
import { deactivateCommentDraftApi } from "../collaboration/commentDraftStore";
import { collaborationBridge } from "../bridge";
import type { CollaborationStatus, PlanWeaveCollaborationApi } from "../../shared/collaboration.js";
import { collaborationStatusStore } from "../collaboration/collaborationStatusStore";

export type UseCollaborationStatusArgs = {
  /** Injected bridge for tests; defaults to window.planweaveCollaboration. */
  api?: PlanWeaveCollaborationApi | null;
};

export type UseCollaborationStatusResult = {
  status: CollaborationStatus | null;
  draftScope: string | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

const unavailable = { status: null, draftScope: null, loading: false, error: null };
const readUnavailable = () => unavailable;
const subscribeUnavailable = () => () => undefined;
const refreshUnavailable = async () => undefined;

/** Shared status only; session and observer socket ownership remain in main. */
export function useCollaborationStatus(
  args: UseCollaborationStatusArgs = {}
): UseCollaborationStatusResult {
  const api = args.api === undefined ? collaborationBridge : args.api;
  const previousApi = useRef(api);
  useEffect(() => {
    if (!api && previousApi.current) deactivateCommentDraftApi(previousApi.current);
    previousApi.current = api;
  }, [api]);
  const store = api ? collaborationStatusStore(api) : null;
  useEffect(() => {
    store?.activate();
  }, [store]);
  const snapshot = useSyncExternalStore(
    store?.subscribe ?? subscribeUnavailable,
    store?.getSnapshot ?? readUnavailable,
    readUnavailable
  );
  return { ...snapshot, refresh: store?.refresh ?? refreshUnavailable };
}
