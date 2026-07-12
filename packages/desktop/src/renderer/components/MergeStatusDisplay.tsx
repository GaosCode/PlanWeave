import type { RemoteMergeStatus } from "../../shared/remoteTypes.js"

type MergeStatusDisplayProps = {
  mergeStatus: RemoteMergeStatus
}

export function MergeStatusDisplay({ mergeStatus }: MergeStatusDisplayProps) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-input bg-muted/30 px-2 py-1 text-xs">
      <span className="text-foreground">
        Sync: <span className="font-semibold text-green-600">+{mergeStatus.aheadCount}</span>
        {" / "}
        <span className="font-semibold text-amber-600">-{mergeStatus.behindCount}</span>
      </span>
      {mergeStatus.hasConflicts && (
        <span className="rounded bg-destructive/20 px-1.5 py-0.5 text-destructive font-medium">Conflicts</span>
      )}
      {mergeStatus.lastSyncedEventId && (
        <span className="text-muted-foreground">#{mergeStatus.lastSyncedEventId}</span>
      )}
    </div>
  )
}
