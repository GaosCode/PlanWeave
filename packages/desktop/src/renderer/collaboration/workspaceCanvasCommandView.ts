export type WorkspaceCanvasCommandSnapshot = {
  session: {
    canvasId: string;
    revision: number;
    contentDigest: string | null;
    lastOperationId: string | null;
    lastJournalEntryId: string | null;
    pendingOperationId: string | null;
    lastConflict: {
      expectedRevision: number;
      authoritativeRevision: number;
      authoritativeContentDigest: string;
    } | null;
    lastRejectCode: string | null;
  } | null;
  connectionPhase: "idle" | "connecting" | "connected" | "disconnected";
  lastError: string | null;
  lastStaleConflict: {
    expectedRevision: number;
    authoritativeRevision: number;
    authoritativeContentDigest: string;
  } | null;
  busy: boolean;
};

export type WorkspaceCanvasCommandLabels = {
  staleRevision: (expected: number, authoritative: number) => string;
  rejected: (code: string) => string;
  reconnectFailed: (code: string) => string;
  notConnected: string;
};
