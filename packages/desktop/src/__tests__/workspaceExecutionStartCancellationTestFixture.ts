import {
  remoteOperationObservationSchema,
  type RemoteOperationObservation
} from "@planweave-ai/collaboration-protocol/remote-run";
import { applyMigrations } from "../../../server/src/migrations.js";
import {
  RemoteExecutionActionRepository,
  RemoteExecutionActionService
} from "../../../server/src/remoteExecutionActions.js";
import type { SqliteDatabase } from "../../../server/src/sqlite.js";

export function createStartCancellationServerFixture(input: {
  database: SqliteDatabase;
  read: () => RemoteOperationObservation;
  write: (observation: RemoteOperationObservation) => void;
}) {
  const db = input.database;
  applyMigrations(db);
  db.exec("PRAGMA foreign_keys=OFF");
  const token = "00000000-0000-4000-8000-000000000024";
  db.prepare(
    "INSERT INTO server_instance_ownership(singleton,owner_token,process_id,hostname,acquired_at) VALUES(1,?,1,'test-host',?)"
  ).run(token, "2030-01-01T00:00:00.000Z");
  let sideEffects = 0;
  const engine = new RemoteExecutionActionService(
    new RemoteExecutionActionRepository(db),
    {
      snapshot: () => {
        const observation = input.read();
        return {
          dispatchState: "persisted",
          operationId: observation.operationId,
          dispatchId: observation.dispatchId,
          executionAttemptId: observation.executionAttemptId,
          attemptStatus: observation.attempt.status,
          attemptVersion: observation.attempt.stateVersion,
          leaseId: observation.attempt.leaseId,
          leaseFenced: false,
          hostCapabilities: []
        };
      },
      apply: async () => {
        sideEffects += 1;
        const observation = input.read();
        input.write(
          remoteOperationObservationSchema.parse({
            ...observation,
            state: "cancelled",
            attempt: {
              ...observation.attempt,
              status: "cancelled",
              stateVersion: observation.attempt.stateVersion + 1
            },
            diagnostics: {
              ...observation.diagnostics,
              revision: (observation.diagnostics?.revision ?? 0) + 1
            }
          })
        );
        return "delivered";
      }
    },
    token
  );
  return {
    sideEffects: () => sideEffects,
    execute: async (body: unknown) => {
      const result = await engine.execute(body);
      return {
        request: result.request,
        state: result.state,
        createdAt: result.createdAt,
        deliveredAt: result.deliveredAt
      };
    }
  };
}
