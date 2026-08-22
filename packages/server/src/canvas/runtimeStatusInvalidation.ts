import type { HumanObserverJournal } from "../humanObserverJournal.js";
import type { SqliteDatabase } from "../sqlite.js";
import { CanvasRuntimeStatusRepository } from "./runtimeStatusRepository.js";

export function createInvalidatingCanvasRuntimeStatusRepository(options: {
  database: SqliteDatabase;
  observerJournal: HumanObserverJournal;
  clock?: () => Date;
}): CanvasRuntimeStatusRepository {
  return new CanvasRuntimeStatusRepository(
    options.database,
    options.clock,
    ({ runtimeRevision, status }) => {
      options.observerJournal.appendInCallerTransaction(
        {
          workspaceId: status.scope.workspaceId,
          projectId: status.scope.projectId
        },
        {
          kind: "runtime",
          canvasId: status.scope.canvasId,
          runtimeRevision
        }
      );
    }
  );
}
