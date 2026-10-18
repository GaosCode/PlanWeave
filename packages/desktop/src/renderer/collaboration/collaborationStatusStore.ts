import type { CollaborationStatus, PlanWeaveCollaborationApi } from "../../shared/collaboration.js";
import {
  activateCommentDraftApi,
  getCommentDraftScope,
  getCommentDraftApiActivation,
  updateCommentDraftStatus
} from "./commentDraftStore";

export type CollaborationStatusSnapshot = {
  status: CollaborationStatus | null;
  draftScope: string | null;
  loading: boolean;
  error: string | null;
};

/** The shell and secondary inspectors keep this subscription alive while popovers unmount. */
class CollaborationStatusStore {
  private snapshot: CollaborationStatusSnapshot;
  private listeners = new Set<() => void>();
  private unsubscribe: (() => void) | null = null;
  private generation = 0;
  private activation: number | null = null;

  constructor(private readonly api: PlanWeaveCollaborationApi) {
    this.snapshot = {
      status: null,
      draftScope: getCommentDraftScope(api),
      loading: true,
      error: null
    };
  }

  getSnapshot = () => this.snapshot;

  activate = () => {
    const activation = activateCommentDraftApi(this.api);
    const changedActivation = this.activation !== activation;
    this.activation = activation;
    if (changedActivation) ++this.generation;
    const draftScope = this.snapshot.status
      ? updateCommentDraftStatus(this.api, this.snapshot.status)
      : getCommentDraftScope(this.api);
    if (draftScope !== this.snapshot.draftScope) this.publish({ ...this.snapshot, draftScope });
    if (changedActivation && this.listeners.size > 0) void this.refresh();
  };

  private publish(next: CollaborationStatusSnapshot) {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }

  private accept(status: CollaborationStatus) {
    this.publish({
      status,
      draftScope: updateCommentDraftStatus(this.api, status),
      loading: false,
      error: null
    });
  }

  refresh = async (): Promise<void> => {
    const activation = getCommentDraftApiActivation(this.api);
    if (activation === null) return;
    const generation = ++this.generation;
    const isCurrent = () =>
      generation === this.generation && activation === getCommentDraftApiActivation(this.api);
    this.publish({ ...this.snapshot, loading: true });
    try {
      const status = await this.api.getCollaborationStatus();
      if (isCurrent()) this.accept(status);
    } catch (error) {
      if (isCurrent()) {
        this.publish({
          ...this.snapshot,
          loading: false,
          error: error instanceof Error ? error.message : "collaboration_status_failed"
        });
      }
    }
  };

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      this.activation = activateCommentDraftApi(this.api);
      this.snapshot = {
        status: null,
        draftScope: getCommentDraftScope(this.api),
        loading: true,
        error: null
      };
      this.unsubscribe = this.api.onCollaborationStatusChanged((status) => {
        ++this.generation;
        this.accept(status);
      });
      void this.refresh();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        ++this.generation;
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.snapshot = {
          status: null,
          draftScope: getCommentDraftScope(this.api),
          loading: true,
          error: null
        };
      }
    };
  };
}

const stores = new WeakMap<PlanWeaveCollaborationApi, CollaborationStatusStore>();
export function collaborationStatusStore(api: PlanWeaveCollaborationApi) {
  let store = stores.get(api);
  if (!store) {
    store = new CollaborationStatusStore(api);
    stores.set(api, store);
  }
  return store;
}
