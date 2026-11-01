import { z } from "zod";
import {
  ACP_CONVERSATION_FAILURE_CODE_MAX_LENGTH,
  type AcpConversationCommand,
  type AcpConversationInteraction
} from "@planweave-ai/agent-host-protocol";
import type {
  AcpEngineInteractionBroker,
  AcpEngineInteractionContext
} from "@planweave-ai/runtime";
import type { AcpConversationRepository } from "../state/acpConversationRepository.js";
import { CalibratedServerClock } from "../transport/calibratedServerClock.js";
import type { HostTransportClock } from "../transport/hostTransport.js";
import { systemHostTransportClock } from "../transport/hostTransport.js";
import { RemoteAcpConversationSetupError, type RemoteAcpExecutor } from "./remoteAcpExecutor.js";
import { agentHostRemoteEngineEventSchema } from "./remoteAcpPorts.js";
import { remoteAcpEngineFragment } from "./remoteAcpEngineFragment.js";

export class RemoteAcpConversationService {
  private persistenceFailure: unknown;
  private readonly active = new Map<string, AbortController>();
  private readonly sessions = new Map<string, string>();
  private readonly unsafeSessions = new Set<string>();
  private readonly runs = new Set<Promise<void>>();
  private readonly deadlineChecks = new Map<string, () => void>();
  private readonly serverClock: CalibratedServerClock;
  private stopped = false;
  constructor(
    private readonly repository: AcpConversationRepository,
    private readonly executor: Pick<RemoteAcpExecutor, "converse">,
    private readonly clock: HostTransportClock = systemHostTransportClock,
    serverClock?: CalibratedServerClock
  ) {
    this.serverClock = serverClock ?? new CalibratedServerClock(clock);
    this.serverClock.subscribe(() => {
      for (const check of this.deadlineChecks.values()) check();
    });
    for (const sessionId of repository.unsafeSessions()) this.unsafeSessions.add(sessionId);
  }

  recover(): void {
    if (this.persistenceFailure) throw this.persistenceFailure;
    this.stopped = false;
    const queued = this.repository.recover(new Set(this.active.keys()));
    for (const sessionId of this.repository.unsafeSessions()) this.unsafeSessions.add(sessionId);
    for (const turnId of queued) this.launch(turnId);
  }

  handle(command: AcpConversationCommand): void {
    if (this.persistenceFailure) throw this.persistenceFailure;
    if (command.type === "acp_conversation.prompt") this.launch(command.turnId);
    else if (command.type === "acp_conversation.cancel") this.active.get(command.turnId)?.abort();
  }

  isSessionActive(sessionId: string): boolean {
    return this.sessions.has(sessionId) || this.unsafeSessions.has(sessionId);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const controller of this.active.values()) controller.abort();
    await Promise.all(this.runs);
    if (this.persistenceFailure) throw this.persistenceFailure;
  }

  private launch(turnId: string): void {
    if (this.stopped || this.active.has(turnId) || !this.repository.isQueued(turnId)) return;
    const command = this.repository.command(turnId);
    if (this.unsafeSessions.has(command.sessionId)) {
      this.repository.append(turnId, {
        kind: "status",
        status: "failed",
        error: "acp_conversation_session_cleanup_unverified"
      });
      return;
    }
    if (this.sessions.has(command.sessionId)) return;
    this.sessions.set(command.sessionId, turnId);
    let started: boolean;
    try {
      started = this.repository.start(turnId);
    } catch (error) {
      this.sessions.delete(command.sessionId);
      throw error;
    }
    if (!started) {
      this.sessions.delete(command.sessionId);
      return;
    }
    const controller = new AbortController();
    this.active.set(turnId, controller);
    const deadlineMs = Date.parse(command.expiresAt);
    let timer: unknown;
    const checkDeadline = () => {
      if (timer !== undefined) this.clock.clearTimeout(timer);
      if (this.serverClock.now().getTime() >= deadlineMs) {
        controller.abort("acp_conversation_deadline_exceeded");
      } else {
        timer = this.clock.setTimeout(
          checkDeadline,
          Math.min(1_000, deadlineMs - this.serverClock.now().getTime())
        );
      }
    };
    this.deadlineChecks.set(turnId, checkDeadline);
    checkDeadline();
    const run = this.execute(turnId, controller, deadlineMs)
      .catch((failure) => {
        this.persistenceFailure = failure;
        throw failure;
      })
      .finally(() => {
        if (timer !== undefined) this.clock.clearTimeout(timer);
        this.deadlineChecks.delete(turnId);
        this.active.delete(turnId);
        this.sessions.delete(command.sessionId);
        this.runs.delete(run);
        if (!this.stopped && !this.persistenceFailure) {
          for (const queuedTurnId of this.repository.queued()) this.launch(queuedTurnId);
        }
      });
    this.runs.add(run);
    void run.catch((error) => {
      this.persistenceFailure = error;
    });
  }

  private async execute(
    turnId: string,
    controller: AbortController,
    deadlineMs: number
  ): Promise<void> {
    let status: "completed" | "cancelled" | "failed" = "failed";
    let error: string | null = null;
    let cleanupSafe = true;
    let cleanupObserved = false;
    let executorStarted = false;
    try {
      const command = this.repository.command(turnId);
      if (this.repository.cancelled(turnId)) controller.abort();
      if (this.serverClock.now().getTime() >= deadlineMs)
        throw new Error("acp_conversation_deadline_exceeded");
      if (controller.signal.aborted) throw new Error("acp_conversation_cancelled");
      executorStarted = true;
      const outcome = await this.executor.converse(
        command,
        this.broker(turnId),
        async (event) => {
          if (
            event.kind === "session_update" &&
            (event.body.kind === "artifact" || event.body.kind === "terminal")
          )
            return;
          const safeEvent = agentHostRemoteEngineEventSchema.parse(event);
          if (
            (safeEvent.kind === "session_started" || safeEvent.kind === "session_update") &&
            safeEvent.sessionId !== command.sessionId
          ) {
            throw new Error("acp_conversation_session_mismatch");
          }
          if (controller.signal.aborted) throw new Error("acp_conversation_cancelled");
          this.repository.append(turnId, {
            kind: "runner",
            fragment: remoteAcpEngineFragment(safeEvent)
          });
        },
        controller.signal
      );
      cleanupObserved = true;
      cleanupSafe = outcome.cleanup.completed;
      if (!cleanupSafe) throw new Error("acp_conversation_cleanup_failed");
      if (
        this.serverClock.now().getTime() >= deadlineMs ||
        controller.signal.reason === "acp_conversation_deadline_exceeded"
      )
        throw new Error("acp_conversation_deadline_exceeded");
      if (controller.signal.aborted) throw new Error("acp_conversation_cancelled");
      status =
        outcome.terminal.state === "succeeded"
          ? "completed"
          : outcome.terminal.state === "cancelled"
            ? "cancelled"
            : "failed";
      if (status === "failed") error = `acp_conversation_${outcome.terminal.state}`;
    } catch (cause) {
      if (
        executorStarted &&
        !cleanupObserved &&
        !(cause instanceof RemoteAcpConversationSetupError)
      )
        cleanupSafe = false;
      const deadline =
        this.serverClock.now().getTime() >= deadlineMs ||
        controller.signal.reason === "acp_conversation_deadline_exceeded";
      status = deadline ? "failed" : controller.signal.aborted ? "cancelled" : "failed";
      // Engine diagnostics are delivered through its redacted runner events.
      error = deadline
        ? "acp_conversation_deadline_exceeded"
        : status === "cancelled" && cleanupSafe
          ? null
          : cause instanceof Error &&
              cause.message.length <= ACP_CONVERSATION_FAILURE_CODE_MAX_LENGTH &&
              /^acp_conversation_[a-z_]+$/.test(cause.message)
            ? cause.message
            : "acp_conversation_execution_failed";
    }
    if (!cleanupSafe) {
      this.repository.markCleanupUnsafe(turnId);
      this.unsafeSessions.add(this.repository.command(turnId).sessionId);
      if (error !== "acp_conversation_deadline_exceeded") {
        status = "failed";
        error = "acp_conversation_cleanup_failed";
      }
    }
    this.repository.append(turnId, { kind: "status", status, error });
  }

  private broker(turnId: string): AcpEngineInteractionBroker {
    return {
      advertiseElicitation: true,
      requestPermission: async (request, context) => {
        const decision = await this.interaction(
          turnId,
          {
            kind: "permission",
            requestId: request.requestId,
            summary: request.summary,
            options: request.options.map((option) => ({
              optionId: option.optionId,
              label: option.label,
              decision:
                option.kind === "allow_once" || option.kind === "allow_always" ? "approve" : "deny"
            })),
            deadline: this.repository.command(turnId).expiresAt
          },
          context
        );
        if (decision.kind !== "permission") throw new Error("acp_conversation_decision_invalid");
        if (decision.optionId === null) return { kind: "cancel" };
        if (!request.options.some((option) => option.optionId === decision.optionId))
          throw new Error("acp_conversation_decision_invalid");
        return { kind: "select", optionId: decision.optionId };
      },
      requestElicitation: async (request, context) => {
        const decision = await this.interaction(
          turnId,
          {
            kind: "elicitation",
            requestId: request.requestId,
            message: request.message,
            requestedSchema: z.record(z.string(), z.unknown()).parse(request.requestedSchema),
            deadline: this.repository.command(turnId).expiresAt
          },
          context
        );
        if (decision.kind !== "elicitation") throw new Error("acp_conversation_decision_invalid");
        return {
          action: decision.action,
          ...(decision.content === undefined ? {} : { content: decision.content })
        };
      }
    };
  }

  private async interaction(
    turnId: string,
    request: AcpConversationInteraction,
    context: AcpEngineInteractionContext
  ) {
    this.repository.append(turnId, { kind: "interaction", request });
    try {
      return await new Promise<
        Extract<AcpConversationCommand, { type: "acp_conversation.respond" }>["decision"]
      >((resolve, reject) => {
        const finish = (error?: Error) => {
          clearInterval(timer);
          context.signal.removeEventListener("abort", abort);
          if (error) reject(error);
        };
        const abort = () => finish(new Error("acp_conversation_cancelled"));
        const check = () => {
          if (context.signal.aborted) {
            abort();
            return;
          }
          if (this.serverClock.now().getTime() >= Date.parse(request.deadline)) {
            finish(new Error("acp_conversation_interaction_expired"));
            return;
          }
          const response = this.repository.response(turnId, request.requestId);
          if (response) {
            finish();
            resolve(response.decision);
          }
        };
        const timer = setInterval(check, 100);
        context.signal.addEventListener("abort", abort, { once: true });
        check();
      });
    } finally {
      this.repository.append(turnId, { kind: "interaction_settled", requestId: request.requestId });
    }
  }
}
