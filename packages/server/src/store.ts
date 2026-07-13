import type { SqliteDatabase } from "./sqlite.js";
import { inWriteTransaction } from "./sqlite.js";

export type DomainEvent = { projectId: string; aggregateType: string; aggregateId: string; aggregateVersion: number; type: string };
export type UnitOfWork = { database: SqliteDatabase; appendEvent(event: DomainEvent): string; audit(input: { projectId?: string; actorId: string; action: string; aggregateType: string; aggregateId: string; details: Record<string, unknown> }): void };
export type IdempotentCommand<T> = { deviceId: string; route: string; projectId?: string; key: string; requestFingerprint: string; execute(unit: UnitOfWork): T };
export type IdempotentResult<T> = { replayed: boolean; value: T };

function createUnitOfWork(database: SqliteDatabase): UnitOfWork {
  return {
    database,
    appendEvent: (event) => {
      const at = new Date().toISOString();
      const row = database.prepare("INSERT INTO domain_events(project_id,aggregate_type,aggregate_id,aggregate_version,type,occurred_at) VALUES (?,?,?,?,?,?)").run(event.projectId,event.aggregateType,event.aggregateId,event.aggregateVersion,event.type,at);
      return String(row.lastInsertRowid);
    },
    audit: (entry) => {
      database.prepare("INSERT INTO audit_log(project_id,actor_id,action,aggregate_type,aggregate_id,occurred_at,details_json) VALUES (?,?,?,?,?,?,?)").run(entry.projectId ?? null,entry.actorId,entry.action,entry.aggregateType,entry.aggregateId,new Date().toISOString(),JSON.stringify(entry.details));
    }
  };
}

export function executeInUnitOfWork<T>(database: SqliteDatabase, execute: (unit: UnitOfWork) => T): T {
  return inWriteTransaction(database, () => execute(createUnitOfWork(database)));
}

export function executeIdempotent<T>(database: SqliteDatabase, command: IdempotentCommand<T>): IdempotentResult<T> {
  return executeInUnitOfWork(database, (unit) => {
    const prior = database.prepare("SELECT response_json, request_fingerprint FROM idempotency_keys WHERE device_id=? AND route=? AND project_id IS ? AND key=?").get(command.deviceId, command.route, command.projectId ?? null, command.key);
    if (prior) { if (prior.request_fingerprint !== command.requestFingerprint) throw new Error("idempotency_key_reused"); return { replayed: true, value: JSON.parse(String(prior.response_json)) as T }; }
    const value = command.execute(unit);
    database.prepare("INSERT INTO idempotency_keys(device_id,route,project_id,key,request_fingerprint,status_code,response_json,created_at) VALUES (?,?,?,?,?,?,?,?)").run(command.deviceId,command.route,command.projectId ?? null,command.key,command.requestFingerprint,200,JSON.stringify(value),new Date().toISOString());
    return { replayed: false, value };
  });
}
