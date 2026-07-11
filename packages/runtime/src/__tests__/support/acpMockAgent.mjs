#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import { PROTOCOL_VERSION, agent, methods, ndJsonStream, RequestError } from "@agentclientprotocol/sdk";

const scenario = process.argv[2] ?? "success";
const sessions = new Map();
let nextSession = 1;

if (scenario === "early-exit") {
  process.stderr.write("mock ACP exited before initialization\n");
  process.exit(23);
}

if (scenario === "stderr") {
  process.stderr.write("mock ACP diagnostic\n");
}

if (scenario === "stubborn-pending") {
  process.on("SIGTERM", () => process.stderr.write("SIGTERM observed\n"));
  setInterval(() => {}, 1_000);
}

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const app = agent({ name: "planweave-acp-mock" })
  .onRequest(methods.agent.initialize, async (ctx) => {
    const elicitation = ctx.params.clientCapabilities?.elicitation;
    if (scenario === "expect-headless-capabilities" && elicitation != null) {
      throw RequestError.invalidParams({ reason: "headless client advertised elicitation" });
    }
    if (scenario === "expect-broker-capabilities" && elicitation?.form == null) {
      throw RequestError.invalidParams({ reason: "interactive broker omitted form elicitation" });
    }
    if (scenario === "delayed" || scenario === "delayed-artifact-implementation") await pause(40);
    if (scenario === "duplicate-response" || scenario === "unknown-id") {
      const id = scenario === "duplicate-response" ? ctx.requestId : "unknown-request-id";
      setTimeout(() => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: { duplicate: true } })}\n`), 10);
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        ...(scenario === "close-capable" ? { sessionCapabilities: { close: {} } } : {})
      },
      authMethods:
        scenario === "auth-required"
          ? [{ id: "mock-login", name: "Mock login", description: "Test-only authentication" }]
          : [],
      agentInfo: { name: "planweave-acp-mock", version: "1.0.0" }
    };
  })
  .onRequest(methods.agent.authenticate, () => ({}))
  .onRequest(methods.agent.session.new, async () => {
    if (scenario === "auth-required") {
      throw RequestError.authRequired();
    }
    if (scenario === "invalid-envelope-pending" || scenario === "invalid-object-envelope-pending") {
      await pause(100);
    }
    const sessionId = `mock-session-${nextSession++}`;
    sessions.set(sessionId, { cancelled: false });
    return { sessionId };
  })
  .onNotification(methods.agent.session.cancel, (ctx) => {
    const session = sessions.get(ctx.params.sessionId);
    if (session) session.cancelled = true;
  })
  .onRequest(methods.agent.session.close, (ctx) => {
    if (!sessions.delete(ctx.params.sessionId)) {
      throw RequestError.invalidParams({ sessionId: ctx.params.sessionId });
    }
    return {};
  })
  .onRequest(methods.agent.session.prompt, async (ctx) => {
    const { sessionId } = ctx.params;
    const session = sessions.get(sessionId);
    if (!session) throw RequestError.invalidParams({ sessionId });
    if (scenario === "protocol-error") throw RequestError.invalidParams({ reason: "scripted protocol error" });
    if (scenario === "stubborn-pending") {
      await ctx.client.request("mock/pending", { sessionId });
    }

    const artifactText =
      scenario === "artifact-implementation" || scenario === "delayed-artifact-implementation" || scenario === "terminal-output" || scenario === "permission-deny" || scenario === "permission-secret" || scenario === "elicitation-secret" || scenario === "multi-interaction"
        ? `PLANWEAVE_FINAL_ARTIFACT ${JSON.stringify({ version: "planweave.runner-artifact/v1", artifact: { kind: "implementation", ref: "T-001#B-001", taskId: "T-001", reportMarkdown: "implemented\n" } })}\n`
        : scenario === "artifact-review" || scenario === "artifact-review-needs-changes"
          ? `PLANWEAVE_FINAL_ARTIFACT ${JSON.stringify({ version: "planweave.runner-artifact/v1", artifact: { kind: "review", ref: "T-001#R-001", taskId: "T-001", reviewResult: { reviewBlockRef: "T-001#R-001", taskId: "T-001", verdict: scenario === "artifact-review-needs-changes" ? "needs_changes" : "passed", content: scenario === "artifact-review-needs-changes" ? "fix the implementation" : "passed" } } })}\n`
          : scenario === "artifact-feedback"
            ? `PLANWEAVE_FINAL_ARTIFACT ${JSON.stringify({ version: "planweave.runner-artifact/v1", artifact: { kind: "feedback", feedbackId: "FE-001", sourceReviewBlockRef: "T-001#R-001", taskId: "T-001", reportMarkdown: "feedback fixed\n" } })}\n`
            : `hello from ${sessionId}`;
    await ctx.client.notify(methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: artifactText }
      }
    });

    if (scenario === "streaming" || scenario === "permission" || scenario === "permission-deny" || scenario === "permission-secret") {
      await ctx.client.notify(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: `tool-${sessionId}`,
          title: "Inspect fixture",
          kind: "read",
          status: "pending"
        }
      });
    }

    if (scenario === "permission" || scenario === "permission-deny" || scenario === "permission-secret") {
      const permission = await ctx.client.request(methods.client.session.requestPermission, {
        sessionId,
        toolCall: { toolCallId: `tool-${sessionId}`, title: "Inspect fixture", kind: "read" },
        options: scenario === "permission-deny"
          ? [{ optionId: "deny", name: "Deny", kind: "reject_once" }]
          : scenario === "permission-secret"
            ? [{ optionId: "token=opaque-action-id", name: "password=super-secret", kind: "allow_once" }]
            : [{ optionId: "allow", name: "Allow once", kind: "allow_once" }]
      });
      if (scenario === "permission-deny" && permission.outcome.optionId !== "deny") {
        throw RequestError.invalidParams({ reason: "expected deny permission outcome" });
      }
    }

    if (scenario === "multi-interaction") {
      await Promise.all([
        ctx.client.request(methods.client.session.requestPermission, {
          sessionId,
          toolCall: { toolCallId: `tool-${sessionId}`, title: "Concurrent permission", kind: "read" },
          options: [{ optionId: "deny", name: "Deny", kind: "reject_once" }]
        }),
        ctx.client.request(methods.client.elicitation.create, {
          mode: "form",
          sessionId,
          message: "Concurrent elicitation",
          requestedSchema: {
            type: "object",
            properties: { value: { type: "string", title: "Value" } },
            required: ["value"]
          }
        })
      ]);
    }

    if (scenario === "elicitation" || scenario === "unsupported-elicitation" || scenario === "elicitation-secret") {
      await ctx.client.request(methods.client.elicitation.create, {
        mode: scenario === "unsupported-elicitation" ? "url" : "form",
        sessionId,
        message: scenario === "elicitation-secret" ? "Authorization: Bearer secret-token" : "Choose a test value",
        ...(scenario === "unsupported-elicitation" ? { url: "https://example.invalid", elicitationId: "unsupported-1" } : {}),
        requestedSchema: {
          type: "object",
          properties: { value: { type: "string", title: "Value", ...(scenario === "elicitation-secret" ? { default: "api_key=raw-secret" } : {}) } },
          required: ["value"]
        }
      });
    }

    if (scenario === "terminal-output") {
      await ctx.client.request(methods.client.terminal.output, {
        sessionId,
        terminalId: "terminal-1"
      });
    }

    await ctx.client.notify(methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "usage_update", used: 12, size: 1024 }
    });

    if (scenario === "long-prompt") await pause(500);
    if (scenario === "delayed" || scenario === "delayed-artifact-implementation" || scenario === "late-update") await pause(40);
    if (scenario === "late-update") {
      await ctx.client.notify(methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late" } }
      });
    }
    return { stopReason: session.cancelled ? "cancelled" : "end_turn" };
  });

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
const connection = app.connect(stream);

if (scenario === "malformed") {
  setTimeout(() => process.stdout.write("{not-json}\n"), 20);
}

if (scenario === "invalid-envelope-pending") {
  setTimeout(() => process.stdout.write("42\n"), 20);
}

if (scenario === "invalid-object-envelope-pending") {
  setTimeout(
    () =>
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: 1, id: 7, result: {} })}\n`
      ),
    20
  );
}

await connection.closed;
