import type { Migration } from "./types.js";

/** Durable diagnostic evidence. It is observational and never drives operation lifecycle. */
export const remoteOperationDiagnosticsMigration: Migration = {
  version: 63,
  sql: `
CREATE TABLE IF NOT EXISTS remote_operation_diagnostics (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL REFERENCES remote_operations(id),
  execution_attempt_id TEXT NOT NULL REFERENCES remote_execution_attempts(execution_attempt_id),
  stage TEXT NOT NULL CHECK(stage IN (
    'authorizing','resolving_endpoint','reserving_host','attaching_runtime',
    'preparing_runtime','materializing','dispatching','running','writing_back',
    'cancelling','terminal'
  )),
  error_code TEXT,
  error_retryable INTEGER CHECK(error_retryable IN (0,1)),
  occurred_at TEXT NOT NULL,
  CHECK((error_code IS NULL) = (error_retryable IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_remote_operation_diagnostics_latest
  ON remote_operation_diagnostics(operation_id,sequence DESC);

INSERT INTO remote_operation_diagnostics(
  operation_id,execution_attempt_id,stage,error_code,error_retryable,occurred_at
)
SELECT id,execution_attempt_id,
  CASE
    WHEN state IN ('completed','failed','cancelled') THEN 'terminal'
    WHEN state='awaiting_writeback' THEN 'writing_back'
    WHEN state IN ('running','interrupted','action_required') THEN 'running'
    WHEN state='activated' THEN 'dispatching'
    WHEN state='reserved' THEN 'attaching_runtime'
    ELSE 'preparing_runtime'
  END,
  diagnostic_code,
  CASE WHEN diagnostic_code IS NULL THEN NULL ELSE 0 END,
  updated_at
FROM remote_operations AS operation
WHERE NOT EXISTS (
  SELECT 1 FROM remote_operation_diagnostics AS diagnostic
  WHERE diagnostic.operation_id=operation.id
);
`
};
