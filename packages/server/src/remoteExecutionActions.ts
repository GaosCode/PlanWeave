import { createHash } from "node:crypto";
import { z } from "zod";
import {
  decideRemoteExecutionAction,
  nextRemoteExecutionActionState,
  remoteExecutionActionRejectionCodeSchema,
  remoteExecutionActionRequestSchema,
  remoteExecutionActionStateSchema,
  type RemoteExecutionActionRequest,
  type RemoteExecutionActionRejectionCode,
  type RemoteExecutionActionDecision,
  type RemoteExecutionActionState,
  type RemoteExecutionLifecycleSnapshot
} from "./remoteExecutionLifecycle.js";
import { inWriteTransaction, type SqliteDatabase } from "./sqlite.js";
import { assertServerInstanceOwnership } from "./serverInstanceOwnership.js";

const timestampSchema = z.iso.datetime();
const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const applicationDecisionSchema = z.discriminatedUnion("transition", [
  z.object({ transition: z.literal("resume"), sendsCommand: z.literal(true) }).strict(),
  z.object({ transition: z.literal("retry"), sendsCommand: z.literal(false) }).strict(),
  z.object({ transition: z.literal("fail"), sendsCommand: z.literal(false) }).strict(),
  z.object({ transition: z.literal("block"), sendsCommand: z.literal(false) }).strict(),
  z.object({ transition: z.literal("cancel"), sendsCommand: z.boolean() }).strict()
]);
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema)
  ])
);
const applicationPlanSchema = z
  .object({
    decision: applicationDecisionSchema,
    context: jsonValueSchema.optional()
  })
  .strict();
type RemoteExecutionActionApplicationContext = z.infer<typeof applicationPlanSchema>["context"];

const actionRowSchema = z
  .object({
    action_id: z.string(),
    operation_id: z.string(),
    dispatch_id: z.string(),
    execution_attempt_id: z.string(),
    kind: z.string(),
    request_fingerprint: fingerprintSchema,
    request_json: z.string(),
    state: remoteExecutionActionStateSchema,
    created_at: timestampSchema,
    delivered_at: timestampSchema.nullable(),
    acknowledged_at: timestampSchema.nullable(),
    settled_at: timestampSchema.nullable(),
    rejected_at: timestampSchema.nullable(),
    rejection_code: remoteExecutionActionRejectionCodeSchema.nullable(),
    application_owner_token: z.string().uuid().nullable(),
    application_claimed_at: timestampSchema.nullable(),
    application_decision_json: z.string().nullable()
  })
  .strict();

export type RemoteExecutionActionRecord = {
  request: RemoteExecutionActionRequest;
  requestFingerprint: string;
  state: RemoteExecutionActionState;
  createdAt: string;
  deliveredAt?: string;
  acknowledgedAt?: string;
  settledAt?: string;
  rejectedAt?: string;
  rejectionCode?: RemoteExecutionActionRejectionCode;
};

function serializeRequest(request: RemoteExecutionActionRequest): {
  json: string;
  fingerprint: string;
} {
  const json = JSON.stringify(request);
  return {
    json,
    fingerprint: createHash("sha256").update(json).digest("hex")
  };
}

function toRecord(row: Record<string, unknown>): RemoteExecutionActionRecord {
  const parsed = actionRowSchema.parse(row);
  if (
    (parsed.application_owner_token === null) !== (parsed.application_claimed_at === null) ||
    (parsed.application_owner_token !== null && parsed.state !== "recorded") ||
    (parsed.application_decision_json !== null && parsed.state !== "recorded")
  ) {
    throw new Error("remote_action_row_claim_mismatch");
  }
  if (
    (parsed.state === "rejected" && (!parsed.rejected_at || !parsed.rejection_code)) ||
    (parsed.state !== "rejected" && (parsed.rejected_at || parsed.rejection_code))
  ) {
    throw new Error("remote_action_row_rejection_mismatch");
  }
  const request = remoteExecutionActionRequestSchema.parse(JSON.parse(parsed.request_json));
  if (
    request.actionId !== parsed.action_id ||
    request.operationId !== parsed.operation_id ||
    request.dispatchId !== parsed.dispatch_id ||
    request.executionAttemptId !== parsed.execution_attempt_id ||
    request.kind !== parsed.kind
  ) {
    throw new Error("remote_action_row_identity_mismatch");
  }
  const serialized = serializeRequest(request);
  if (
    serialized.json !== parsed.request_json ||
    serialized.fingerprint !== parsed.request_fingerprint
  ) {
    throw new Error("remote_action_row_payload_mismatch");
  }
  return {
    request,
    requestFingerprint: parsed.request_fingerprint,
    state: parsed.state,
    createdAt: parsed.created_at,
    deliveredAt: parsed.delivered_at ?? undefined,
    acknowledgedAt: parsed.acknowledged_at ?? undefined,
    settledAt: parsed.settled_at ?? undefined,
    rejectedAt: parsed.rejected_at ?? undefined,
    rejectionCode: parsed.rejection_code ?? undefined
  };
}

export class RemoteExecutionActionRejectedError extends Error {
  constructor(
    readonly code: RemoteExecutionActionRejectionCode,
    options?: ErrorOptions
  ) {
    super(code, options);
    this.name = "RemoteExecutionActionRejectedError";
  }
}

export class RemoteExecutionActionRepository {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly clock: () => Date = () => new Date()
  ) {}

  record(rawRequest: unknown): RemoteExecutionActionRecord {
    const request = remoteExecutionActionRequestSchema.parse(rawRequest);
    const serialized = serializeRequest(request);
    return inWriteTransaction(this.database, () => {
      const existing = this.get(request.actionId);
      if (existing) {
        if (
          existing.requestFingerprint !== serialized.fingerprint ||
          JSON.stringify(existing.request) !== serialized.json
        ) {
          throw new Error("remote_action_idempotency_conflict");
        }
        return existing;
      }
      this.database
        .prepare(
          `INSERT INTO remote_execution_actions(
            action_id,operation_id,dispatch_id,execution_attempt_id,kind,
            request_fingerprint,request_json,state,created_at
          ) VALUES (?,?,?,?,?,?,?,'recorded',?)`
        )
        .run(
          request.actionId,
          request.operationId,
          request.dispatchId,
          request.executionAttemptId,
          request.kind,
          serialized.fingerprint,
          serialized.json,
          this.clock().toISOString()
        );
      return this.getRequired(request.actionId);
    });
  }

  get(actionId: string): RemoteExecutionActionRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM remote_execution_actions WHERE action_id=?")
      .get(actionId);
    return row ? toRecord(row) : undefined;
  }

  getRequired(actionId: string): RemoteExecutionActionRecord {
    const action = this.get(actionId);
    if (!action) throw new Error("remote_action_not_found");
    return action;
  }

  transition(
    actionId: string,
    next: Exclude<RemoteExecutionActionState, "rejected">
  ): RemoteExecutionActionRecord {
    const parsedNext = remoteExecutionActionStateSchema.parse(next);
    return inWriteTransaction(this.database, () => {
      const action = this.getRequired(actionId);
      const state = nextRemoteExecutionActionState(action.state, parsedNext);
      if (state === action.state) return action;
      const now = this.clock().toISOString();
      const column =
        state === "delivered"
          ? "delivered_at"
          : state === "acknowledged"
            ? "acknowledged_at"
            : "settled_at";
      const updated = this.database
        .prepare(
          `UPDATE remote_execution_actions SET state=?,${column}=?
           WHERE action_id=? AND state=? AND application_owner_token IS NULL`
        )
        .run(state, now, action.request.actionId, action.state);
      if (updated.changes !== 1) throw new Error("remote_action_state_conflict");
      return this.getRequired(action.request.actionId);
    });
  }

  claimApplication(
    actionId: string,
    ownerToken: string,
    options: { takeoverExistingClaim?: boolean } = {}
  ): {
    action: RemoteExecutionActionRecord;
    decision?: RemoteExecutionActionDecision;
    context?: RemoteExecutionActionApplicationContext;
  } {
    return inWriteTransaction(this.database, () => {
      assertServerInstanceOwnership(this.database, ownerToken);
      const action = this.getRequired(actionId);
      if (action.state !== "recorded") throw new Error("remote_action_not_recorded");
      const row = actionRowSchema.parse(
        this.database
          .prepare("SELECT * FROM remote_execution_actions WHERE action_id=?")
          .get(actionId)
      );
      const now = this.clock().toISOString();
      const claimed = row.application_owner_token
        ? options.takeoverExistingClaim === true
          ? this.database
              .prepare(
                `UPDATE remote_execution_actions
                 SET application_owner_token=?,application_claimed_at=?
                 WHERE action_id=? AND state='recorded' AND application_owner_token=?`
              )
              .run(ownerToken, now, actionId, row.application_owner_token)
          : { changes: 0 }
        : this.database
            .prepare(
              `UPDATE remote_execution_actions
               SET application_owner_token=?,application_claimed_at=?
               WHERE action_id=? AND state='recorded' AND application_owner_token IS NULL`
            )
            .run(ownerToken, now, actionId);
      if (claimed.changes !== 1) throw new Error("remote_action_in_progress");
      const plan = row.application_decision_json
        ? applicationPlanSchema.parse(JSON.parse(row.application_decision_json))
        : undefined;
      return { action: this.getRequired(actionId), ...plan };
    });
  }

  recordApplicationPlan(
    actionId: string,
    ownerToken: string,
    decision: RemoteExecutionActionDecision,
    context?: RemoteExecutionActionApplicationContext
  ): z.infer<typeof applicationPlanSchema> {
    const plan = applicationPlanSchema.parse({ decision, context });
    const decisionJson = JSON.stringify(plan);
    return inWriteTransaction(this.database, () => {
      assertServerInstanceOwnership(this.database, ownerToken);
      const updated = this.database
        .prepare(
          `UPDATE remote_execution_actions SET application_decision_json=?
           WHERE action_id=? AND state='recorded' AND application_owner_token=?
             AND application_decision_json IS NULL`
        )
        .run(decisionJson, actionId, ownerToken);
      if (updated.changes !== 1) throw new Error("remote_action_application_claim_lost");
      return plan;
    });
  }

  completeApplication(
    actionId: string,
    ownerToken: string,
    next: "delivered" | "settled"
  ): RemoteExecutionActionRecord {
    return inWriteTransaction(this.database, () => {
      assertServerInstanceOwnership(this.database, ownerToken);
      const now = this.clock().toISOString();
      const column = next === "delivered" ? "delivered_at" : "settled_at";
      const updated = this.database
        .prepare(
          `UPDATE remote_execution_actions
           SET state=?,${column}=?,application_owner_token=NULL,application_claimed_at=NULL,
               application_decision_json=NULL
           WHERE action_id=? AND state='recorded' AND application_owner_token=?`
        )
        .run(next, now, actionId, ownerToken);
      if (updated.changes !== 1) throw new Error("remote_action_application_claim_lost");
      return this.getRequired(actionId);
    });
  }

  rejectApplication(
    actionId: string,
    ownerToken: string,
    rawCode: RemoteExecutionActionRejectionCode
  ): RemoteExecutionActionRecord {
    const code = remoteExecutionActionRejectionCodeSchema.parse(rawCode);
    return inWriteTransaction(this.database, () => {
      assertServerInstanceOwnership(this.database, ownerToken);
      const updated = this.database
        .prepare(
          `UPDATE remote_execution_actions
           SET state='rejected',rejected_at=?,rejection_code=?,
               application_owner_token=NULL,application_claimed_at=NULL,
               application_decision_json=NULL
           WHERE action_id=? AND state='recorded' AND application_owner_token=?`
        )
        .run(this.clock().toISOString(), code, actionId, ownerToken);
      if (updated.changes !== 1) throw new Error("remote_action_application_claim_lost");
      return this.getRequired(actionId);
    });
  }

  releaseApplicationAndDiscardPlan(
    actionId: string,
    ownerToken: string
  ): RemoteExecutionActionRecord {
    return inWriteTransaction(this.database, () => {
      assertServerInstanceOwnership(this.database, ownerToken);
      const updated = this.database
        .prepare(
          `UPDATE remote_execution_actions
           SET application_owner_token=NULL,application_claimed_at=NULL,
               application_decision_json=NULL
           WHERE action_id=? AND state='recorded' AND application_owner_token=?`
        )
        .run(actionId, ownerToken);
      if (updated.changes !== 1) throw new Error("remote_action_application_claim_lost");
      return this.getRequired(actionId);
    });
  }

  releaseApplicationPreservingPlan(
    actionId: string,
    ownerToken: string
  ): RemoteExecutionActionRecord {
    return inWriteTransaction(this.database, () => {
      assertServerInstanceOwnership(this.database, ownerToken);
      const updated = this.database
        .prepare(
          `UPDATE remote_execution_actions
           SET application_owner_token=NULL,application_claimed_at=NULL
           WHERE action_id=? AND state='recorded' AND application_owner_token=?
             AND application_decision_json IS NOT NULL`
        )
        .run(actionId, ownerToken);
      if (updated.changes !== 1) throw new Error("remote_action_application_claim_lost");
      return this.getRequired(actionId);
    });
  }

  releaseApplicationClaimIfOwned(actionId: string, ownerToken: string): void {
    inWriteTransaction(this.database, () => {
      assertServerInstanceOwnership(this.database, ownerToken);
      this.database
        .prepare(
          `UPDATE remote_execution_actions
           SET application_owner_token=NULL,application_claimed_at=NULL
           WHERE action_id=? AND state='recorded' AND application_owner_token=?`
        )
        .run(actionId, ownerToken);
    });
  }

  listUnsettled(): RemoteExecutionActionRecord[] {
    return this.database
      .prepare(
        `SELECT * FROM remote_execution_actions
         WHERE state IN ('recorded','delivered','acknowledged') ORDER BY created_at,action_id`
      )
      .all()
      .map(toRecord);
  }

  acknowledgeMailbox(messageId: string): RemoteExecutionActionRecord | undefined {
    const action = this.get(messageId);
    if (
      !action ||
      (action.request.kind !== "cancel" && action.request.kind !== "resume_same_session")
    ) {
      return undefined;
    }
    if (action.state === "recorded") this.transition(messageId, "delivered");
    const current = this.getRequired(messageId);
    return current.state === "settled" ? current : this.transition(messageId, "acknowledged");
  }

  settleAttemptCommands(input: {
    dispatchId: string;
    executionAttemptId: string;
    kinds: readonly ("cancel" | "resume_same_session")[];
  }): RemoteExecutionActionRecord[] {
    const rows = this.database
      .prepare(
        `SELECT action_id FROM remote_execution_actions
         WHERE dispatch_id=? AND execution_attempt_id=?
           AND state IN ('recorded','delivered','acknowledged')
         ORDER BY created_at,action_id`
      )
      .all(input.dispatchId, input.executionAttemptId);
    const settled: RemoteExecutionActionRecord[] = [];
    for (const row of rows) {
      const action = this.getRequired(String(row.action_id));
      if (input.kinds.includes(action.request.kind as "cancel" | "resume_same_session")) {
        settled.push(this.transition(action.request.actionId, "settled"));
      }
    }
    return settled;
  }
}

export interface RemoteExecutionActionApplicationPort {
  recover?(
    request: RemoteExecutionActionRequest
  ): "delivered" | "settled" | undefined | Promise<"delivered" | "settled" | undefined>;
  snapshot(
    request: RemoteExecutionActionRequest
  ): RemoteExecutionLifecycleSnapshot | Promise<RemoteExecutionLifecycleSnapshot>;
  prepare?(
    request: RemoteExecutionActionRequest,
    decision: RemoteExecutionActionDecision
  ): RemoteExecutionActionApplicationContext | Promise<RemoteExecutionActionApplicationContext>;
  apply(
    request: RemoteExecutionActionRequest,
    decision: RemoteExecutionActionDecision,
    context?: RemoteExecutionActionApplicationContext
  ): "delivered" | "settled" | Promise<"delivered" | "settled">;
  afterApply?(request: RemoteExecutionActionRequest): void | Promise<void>;
}

export class RemoteExecutionActionService {
  private readonly inFlight = new Map<string, Promise<RemoteExecutionActionRecord>>();

  constructor(
    private readonly actions: RemoteExecutionActionRepository,
    private readonly application: RemoteExecutionActionApplicationPort,
    private readonly serverInstanceOwnerToken: string
  ) {}

  execute(rawRequest: unknown): Promise<RemoteExecutionActionRecord> {
    const action = this.actions.record(rawRequest);
    if (action.state === "rejected") {
      if (!action.rejectionCode) throw new Error("remote_action_row_rejection_mismatch");
      return Promise.reject(new RemoteExecutionActionRejectedError(action.rejectionCode));
    }
    if (action.state === "settled" || action.state === "delivered") {
      return Promise.resolve(action);
    }
    return this.runSingleFlight(action, false);
  }

  private runSingleFlight(
    action: RemoteExecutionActionRecord,
    takeoverExistingClaim: boolean
  ): Promise<RemoteExecutionActionRecord> {
    const actionId = action.request.actionId;
    const current = this.inFlight.get(actionId);
    if (current) return current;
    const execution = this.applyRecorded(action, takeoverExistingClaim);
    this.inFlight.set(actionId, execution);
    const clear = () => {
      if (this.inFlight.get(actionId) === execution) this.inFlight.delete(actionId);
    };
    void execution.then(clear, clear);
    return execution;
  }

  private async applyRecorded(
    action: RemoteExecutionActionRecord,
    takeoverExistingClaim: boolean
  ): Promise<RemoteExecutionActionRecord> {
    const claim = this.actions.claimApplication(
      action.request.actionId,
      this.serverInstanceOwnerToken,
      {
        takeoverExistingClaim
      }
    );
    // Recovery may perform idempotent side effects; a failure retains the durable claim so
    // only a later startup owner can inspect and resume it.
    const recovered = await this.application.recover?.(action.request);
    if (recovered) {
      return this.actions.completeApplication(
        action.request.actionId,
        this.serverInstanceOwnerToken,
        recovered
      );
    }
    let decision = claim.decision;
    let context = claim.context;
    if (!decision) {
      try {
        const snapshot = await this.application.snapshot(action.request);
        const decided = decideRemoteExecutionAction(action.request, snapshot);
        const preparedContext = await this.application.prepare?.(action.request, decided);
        const plan = this.actions.recordApplicationPlan(
          action.request.actionId,
          this.serverInstanceOwnerToken,
          decided,
          preparedContext
        );
        decision = plan.decision;
        context = plan.context;
      } catch (error) {
        if (error instanceof RemoteExecutionActionRejectedError) {
          this.actions.rejectApplication(
            action.request.actionId,
            this.serverInstanceOwnerToken,
            error.code
          );
        } else {
          this.actions.releaseApplicationAndDiscardPlan(
            action.request.actionId,
            this.serverInstanceOwnerToken
          );
        }
        throw error;
      }
    }
    let next: "delivered" | "settled";
    try {
      next = await this.application.apply(action.request, decision, context);
    } catch (error) {
      if (error instanceof RemoteExecutionActionRejectedError) {
        this.actions.rejectApplication(
          action.request.actionId,
          this.serverInstanceOwnerToken,
          error.code
        );
      } else {
        this.actions.releaseApplicationPreservingPlan(
          action.request.actionId,
          this.serverInstanceOwnerToken
        );
      }
      throw error;
    }
    await this.application.afterApply?.(action.request);
    return this.actions.completeApplication(
      action.request.actionId,
      this.serverInstanceOwnerToken,
      next
    );
  }

  acknowledge(actionId: string): RemoteExecutionActionRecord {
    return this.actions.transition(actionId, "acknowledged");
  }

  settle(actionId: string): RemoteExecutionActionRecord {
    return this.actions.transition(actionId, "settled");
  }

  async reconcile(
    startupContext?: {
      serverInstanceOwnerToken: string;
    },
    onFailure?: (action: RemoteExecutionActionRecord, error: unknown) => boolean | Promise<boolean>
  ): Promise<RemoteExecutionActionRecord[]> {
    if (
      startupContext &&
      startupContext.serverInstanceOwnerToken !== this.serverInstanceOwnerToken
    ) {
      throw new Error("remote_action_startup_owner_mismatch");
    }
    const reconciled: RemoteExecutionActionRecord[] = [];
    for (const action of this.actions.listUnsettled()) {
      if (action.state === "recorded") {
        try {
          reconciled.push(await this.runSingleFlight(action, startupContext !== undefined));
        } catch (error) {
          if (!onFailure || !(await onFailure(action, error))) throw error;
          this.actions.releaseApplicationClaimIfOwned(
            action.request.actionId,
            this.serverInstanceOwnerToken
          );
        }
      } else {
        reconciled.push(action);
      }
    }
    return reconciled;
  }
}
