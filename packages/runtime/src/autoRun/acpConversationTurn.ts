import { randomUUID } from "node:crypto";
import type {
  AgentCapabilities,
  LoadSessionRequest,
  LoadSessionResponse,
  PromptRequest,
  PromptResponse,
  SessionNotification
} from "@agentclientprotocol/sdk";
import type { AgentFamily } from "../types.js";
import { createAcpConnection, type CreateAcpConnectionOptions } from "./acpConnection.js";
import { normalizeAcpSessionNotification } from "./acpEventNormalization.js";
import type { AcpEventStore } from "./acpEventStore.js";
import {
  normalizedRedactedContent,
  type NormalizedRunnerEvent
} from "./normalizedEventContract.js";
import { acpCorrelationSchema } from "./runnerContractSchemas.js";
import { redactRunnerEventPayload, redactRunnerEventText } from "./runnerEventRedaction.js";

export type AcpConversationTurnConnection = {
  initialize(): Promise<{ agentCapabilities?: AgentCapabilities }>;
  loadSession(request: LoadSessionRequest): Promise<LoadSessionResponse>;
  prompt(request: PromptRequest): Promise<PromptResponse>;
  dispose(): Promise<void>;
};

export type AcpConversationTurnConnectionOptions = Pick<
  CreateAcpConnectionOptions,
  | "launch"
  | "cwd"
  | "env"
  | "clientInfo"
  | "onSessionUpdate"
  | "onPermissionRequest"
  | "onElicitationRequest"
  | "observer"
  | "defaultTimeoutMs"
>;

type ConversationEventStore = Pick<AcpEventStore, "append" | "appendProtocol" | "drain">;

export type AcpConversationTurnInput = {
  key: string;
  cwd: string;
  sessionId: string;
  agentId: AgentFamily;
  launch: { command: string; args: readonly string[] };
  text: string;
  timeoutMs: number;
  eventStore: ConversationEventStore | (() => Promise<ConversationEventStore>);
};

type TurnStateSubscriber = () => void | Promise<void>;
type ConnectionFactory = (
  options: AcpConversationTurnConnectionOptions
) => AcpConversationTurnConnection;

function environment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}

function diagnostic(error: unknown): string {
  return redactRunnerEventText(error instanceof Error ? error.message : String(error)).text;
}

export class AcpConversationTurnCoordinator {
  private readonly active = new Set<string>();
  private readonly subscribers = new Map<string, Set<TurnStateSubscriber>>();

  constructor(
    private readonly connect: ConnectionFactory = (options) => createAcpConnection(options)
  ) {}

  isInFlight(key: string): boolean {
    return this.active.has(key);
  }

  subscriberCount(key: string): number {
    return this.subscribers.get(key)?.size ?? 0;
  }

  subscribe(key: string, subscriber: TurnStateSubscriber): () => void {
    const subscribers = this.subscribers.get(key) ?? new Set<TurnStateSubscriber>();
    subscribers.add(subscriber);
    this.subscribers.set(key, subscribers);
    return () => {
      subscribers.delete(subscriber);
      if (subscribers.size === 0) this.subscribers.delete(key);
    };
  }

  async send(input: AcpConversationTurnInput): Promise<void> {
    if (this.active.has(input.key)) {
      throw new Error("An ACP conversation turn is already in progress for this run record.");
    }
    this.active.add(input.key);
    await this.notify(input.key);
    try {
      await this.execute(input);
    } finally {
      this.active.delete(input.key);
      await this.notify(input.key);
    }
  }

  private async execute(input: AcpConversationTurnInput): Promise<void> {
    const eventStore =
      typeof input.eventStore === "function" ? await input.eventStore() : input.eventStore;
    let persistNotifications = false;
    let protocolObserverError: unknown;
    const correlation = acpCorrelationSchema.parse({ sessionId: input.sessionId });
    const append = async (body: NormalizedRunnerEvent["body"]): Promise<void> => {
      await eventStore.append(body, correlation);
      await this.notify(input.key);
    };
    const connection = this.connect({
      launch: { trusted: true, ...input.launch },
      cwd: input.cwd,
      env: environment(),
      clientInfo: { name: "planweave", version: "1" },
      onSessionUpdate: async (notification: SessionNotification) => {
        if (!persistNotifications || notification.sessionId !== input.sessionId) return;
        const normalized = normalizeAcpSessionNotification(notification);
        if (normalized) await append(normalized);
      },
      onPermissionRequest: async () => ({ outcome: { outcome: "cancelled" } }),
      onElicitationRequest: async () => ({ action: "cancel" }),
      observer: {
        redact: redactRunnerEventPayload,
        observe: (observation) => {
          if (!persistNotifications) return;
          void eventStore
            .appendProtocol(observation.direction, observation.payload)
            .catch((error) => {
              protocolObserverError ??= error;
            });
        }
      },
      defaultTimeoutMs: input.timeoutMs
    });
    let executionError: unknown;
    const secondaryErrors: unknown[] = [];
    try {
      const initialized = await connection.initialize();
      if (initialized.agentCapabilities?.loadSession !== true) {
        throw new Error(
          `ACP agent '${input.agentId}' does not support loading an existing session.`
        );
      }
      await connection.loadSession({
        sessionId: input.sessionId,
        cwd: input.cwd,
        mcpServers: []
      });
      persistNotifications = true;
      const userContent = normalizedRedactedContent(input.text);
      await append({
        kind: "message",
        role: "user",
        messageId: `desktop-turn-${randomUUID()}`,
        chunk: false,
        ...userContent
      });
      const response = await connection.prompt({
        sessionId: input.sessionId,
        prompt: [{ type: "text", text: input.text }]
      });
      if (response.stopReason === "cancelled") {
        throw new Error("ACP agent cancelled the conversation turn.");
      }
      await eventStore.drain();
      if (protocolObserverError !== undefined) throw protocolObserverError;
    } catch (error) {
      executionError = new Error(`ACP conversation turn failed: ${diagnostic(error)}`, {
        cause: error
      });
      try {
        await append({
          kind: "diagnostic",
          code: "protocol_error",
          message: diagnostic(executionError)
        });
        await eventStore.drain();
      } catch (diagnosticError) {
        secondaryErrors.push(diagnosticError);
      }
    } finally {
      try {
        await connection.dispose();
      } catch (cleanupError) {
        secondaryErrors.push(cleanupError);
        try {
          await append({
            kind: "diagnostic",
            code: "protocol_error",
            message: `ACP conversation turn cleanup failed: ${diagnostic(cleanupError)}`
          });
          await eventStore.drain();
        } catch (diagnosticError) {
          secondaryErrors.push(diagnosticError);
        }
      }
    }
    if (executionError !== undefined) {
      if (secondaryErrors.length > 0) {
        throw new AggregateError([executionError, ...secondaryErrors], diagnostic(executionError), {
          cause: executionError
        });
      }
      throw executionError;
    }
    if (secondaryErrors.length > 0) {
      throw secondaryErrors.length === 1
        ? secondaryErrors[0]
        : new AggregateError(secondaryErrors, "ACP conversation turn cleanup failed.");
    }
  }

  private async notify(key: string): Promise<void> {
    const subscribers = [...(this.subscribers.get(key) ?? [])];
    await Promise.allSettled(subscribers.map(async (subscriber) => subscriber()));
  }
}

export const acpConversationTurns = new AcpConversationTurnCoordinator();
