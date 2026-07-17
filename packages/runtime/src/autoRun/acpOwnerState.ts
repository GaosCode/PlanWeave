import { writeJsonFile } from "../json.js";
import {
  agentRunControlAvailabilitySummarySchema,
  type AgentRunControlAvailabilitySummary
} from "./agentRunControlAvailability.js";

function recoverOwnerStateQueue(_error: unknown): void {
  // The caller awaits the original operation; only the private serialization tail is recovered.
}

export type RunnerOwnerLifecycle = "running" | "waiting_interaction" | "terminal";
export type AcpOwnerTerminalStatus = "completed" | "failed" | "cancelled" | "timed_out";
export type AcpOwnerStatus = "running" | AcpOwnerTerminalStatus;

type AcpOwnerStateWriterOptions = {
  heartbeatPath: string;
  metadataPath: string;
  ownerLeaseId: string;
  ownerGeneration: number;
  startedAt: string;
  controlAvailability: AgentRunControlAvailabilitySummary;
  metadata: Readonly<Record<string, unknown>>;
  write?: (path: string, value: unknown) => Promise<void>;
};

export class AcpOwnerStateWriter {
  private readonly details: Record<string, unknown> = {};
  private pendingInteractionIds: string[] = [];
  private lifecycle: RunnerOwnerLifecycle = "running";
  private status: AcpOwnerStatus = "running";
  private controlAvailability: AgentRunControlAvailabilitySummary;
  private writeChain = Promise.resolve();
  private readonly write: (path: string, value: unknown) => Promise<void>;

  constructor(private readonly options: AcpOwnerStateWriterOptions) {
    if (!Number.isSafeInteger(options.ownerGeneration) || options.ownerGeneration < 1) {
      throw new Error("ACP owner generation must be a positive safe integer.");
    }
    this.controlAvailability = agentRunControlAvailabilitySummarySchema.parse(
      options.controlAvailability
    );
    this.write = options.write ?? writeJsonFile;
  }

  async setControlAvailability(summary: AgentRunControlAvailabilitySummary): Promise<void> {
    this.controlAvailability = agentRunControlAvailabilitySummarySchema.parse(summary);
    await this.persist();
  }

  async update(
    status: AcpOwnerStatus,
    patch: Readonly<Record<string, unknown>> = {}
  ): Promise<void> {
    if (this.lifecycle === "terminal") {
      if (status === "running") return;
      Object.assign(this.details, patch);
      this.status = status;
      await this.persist();
      return;
    }
    Object.assign(this.details, patch);
    this.status = status;
    if (status !== "running") {
      this.lifecycle = "terminal";
      this.pendingInteractionIds = [];
    }
    await this.persist();
  }

  async setInteractionWaiting(requestId: string, waiting: boolean): Promise<void> {
    if (this.lifecycle === "terminal") return;
    const pending = new Set(this.pendingInteractionIds);
    if (waiting) pending.add(requestId);
    else pending.delete(requestId);
    this.pendingInteractionIds = [...pending].sort();
    this.lifecycle = this.pendingInteractionIds.length > 0 ? "waiting_interaction" : "running";
    await this.persist();
  }

  async heartbeat(): Promise<void> {
    if (this.lifecycle === "terminal") return;
    await this.persist();
  }

  private async persist(): Promise<void> {
    const now = new Date().toISOString();
    const status = this.status;
    const lifecycle = this.lifecycle;
    const pendingInteractionIds = [...this.pendingInteractionIds];
    const details = { ...this.details };
    const controlAvailability = { ...this.controlAvailability };
    const operation = this.writeChain.catch(recoverOwnerStateQueue).then(async () => {
      const owner = {
        ownerLeaseId: this.options.ownerLeaseId,
        ownerGeneration: this.options.ownerGeneration,
        runnerLifecycle: lifecycle,
        pendingInteractionIds
      };
      const results = await Promise.allSettled([
        this.write(this.options.heartbeatPath, {
          status,
          pid: null,
          startedAt: this.options.startedAt,
          lastHeartbeatAt: now,
          finishedAt: status === "running" ? null : now,
          ...owner,
          ...controlAvailability,
          ...details
        }),
        this.write(this.options.metadataPath, {
          ...this.options.metadata,
          status,
          outcome: status === "completed" ? "succeeded" : status,
          startedAt: this.options.startedAt,
          finishedAt: status === "running" ? null : now,
          ...owner,
          ...controlAvailability,
          ...details
        })
      ]);
      const failures = results.flatMap((result, index) =>
        result.status === "rejected"
          ? [
              new Error(`${index === 0 ? "Heartbeat" : "Metadata"} persistence failed.`, {
                cause: result.reason
              })
            ]
          : []
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, "ACP owner state persistence failed.");
      }
    });
    this.writeChain = operation.catch(recoverOwnerStateQueue);
    await operation;
  }
}
