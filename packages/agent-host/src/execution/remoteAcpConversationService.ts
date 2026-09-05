import { z } from "zod";
import type {
  AcpConversationCommand,
  AcpConversationInteraction
} from "@planweave-ai/agent-host-protocol";
import type {
  AcpEngineInteractionBroker,
  AcpEngineInteractionContext
} from "@planweave-ai/runtime";
import type { AcpConversationRepository } from "../state/acpConversationRepository.js";
import type { RemoteAcpExecutor } from "./remoteAcpExecutor.js";
import { agentHostRemoteEngineEventSchema } from "./remoteAcpPorts.js";
import { remoteAcpEngineFragment } from "./remoteAcpEngineFragment.js";

export class RemoteAcpConversationService {
  private persistenceFailure: unknown;
  private readonly active = new Map<string, AbortController>();
  private readonly runs = new Set<Promise<void>>();
  constructor(
    private readonly repository: AcpConversationRepository,
    private readonly executor: Pick<RemoteAcpExecutor, "converse">
  ) {}

  recover(): void {
    for (const turnId of this.repository.recover()) this.launch(turnId);
  }

  handle(command: AcpConversationCommand): void {
    if (this.persistenceFailure) throw this.persistenceFailure;
    if (command.type === "acp_conversation.prompt") this.launch(command.turnId);
    else if (command.type === "acp_conversation.cancel") this.active.get(command.turnId)?.abort();
  }

  isSessionActive(sessionId: string): boolean {
    return [...this.active.keys()].some(
      (turnId) => this.repository.command(turnId).sessionId === sessionId
    );
  }

  async stop(): Promise<void> {
    for (const controller of this.active.values()) controller.abort();
    await Promise.all(this.runs);
    if (this.persistenceFailure) throw this.persistenceFailure;
  }

  private launch(turnId: string): void {
    if (this.active.has(turnId) || !this.repository.start(turnId)) return;
    const controller = new AbortController();
    this.active.set(turnId, controller);
    const run = this.execute(turnId, controller).finally(() => {
      this.active.delete(turnId);
      this.runs.delete(run);
    });
    this.runs.add(run);
    void run.catch((error) => {
      this.persistenceFailure = error;
    });
  }

  private async execute(turnId: string, controller: AbortController): Promise<void> {
    let status: "completed" | "cancelled" | "failed" = "failed";
    let error: string | null = null;
    try {
      const command = this.repository.command(turnId);
      if (this.repository.cancelled(turnId)) controller.abort();
      if (Date.parse(command.expiresAt) <= Date.now())
        throw new Error("acp_conversation_deadline_exceeded");
      const terminal = await this.executor.converse(
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
          this.repository.append(turnId, {
            kind: "runner",
            fragment: remoteAcpEngineFragment(safeEvent)
          });
        },
        controller.signal
      );
      status =
        terminal.state === "succeeded"
          ? "completed"
          : terminal.state === "cancelled"
            ? "cancelled"
            : "failed";
      if (status === "failed") error = "acp_conversation_" + terminal.state;
    } catch (cause) {
      status = controller.signal.aborted ? "cancelled" : "failed";
      // Engine diagnostics are delivered through its redacted runner events.
      error =
        cause instanceof Error && /^acp_conversation_[a-z_]+$/.test(cause.message)
          ? cause.message
          : "acp_conversation_execution_failed";
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
            options: [...request.options],
            deadline: context.deadline.toISOString()
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
            deadline: context.deadline.toISOString()
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
          if (Date.now() >= context.deadline.getTime()) {
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
