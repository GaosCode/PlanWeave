import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

let nextSession = 0;
const app = agent()
  .onRequest(methods.agent.initialize, () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: { loadSession: true },
    agentInfo: { name: "interaction-terminal", version: "1" }
  }))
  .onRequest(methods.agent.session.new, () => ({ sessionId: `interaction-${++nextSession}` }))
  .onRequest(methods.agent.session.load, () => ({}))
  .onNotification(methods.agent.session.cancel, () => undefined)
  .onRequest(methods.agent.session.prompt, async (ctx) => {
    const scenario = ctx.params.prompt.find((part) => part.type === "text")?.text ?? "success";
    const sessionId = ctx.params.sessionId;
    if (scenario === "held-success") {
      const directory = process.argv[2];
      writeFileSync(join(directory, "other-started"), "started");
      while (!existsSync(join(directory, "release-other"))) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    if (scenario !== "success" && scenario !== "held-success" && !scenario.startsWith("late-")) {
      const interaction = (
        scenario.includes("elicitation")
          ? ctx.client.request(methods.client.elicitation.create, {
              sessionId,
              mode: "form",
              message: "Choose a value",
              requestedSchema: {
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"]
              }
            })
          : ctx.client.request(methods.client.session.requestPermission, {
              sessionId,
              toolCall: {
                toolCallId: "interaction-tool",
                title: scenario === "large-permission" ? "\u0000".repeat(16384) : "Read file",
                kind: "read"
              },
              options:
                scenario === "large-permission"
                  ? Array.from({ length: 64 }, (_, index) => ({
                      optionId: `allow-${index}`,
                      name: "\u0000".repeat(512),
                      kind: "allow_once"
                    }))
                  : [{ optionId: "deny", name: "Deny", kind: "reject_once" }]
            })
      ).catch((error) => ({ rpcError: error.message }));
      if (!scenario.startsWith("pending")) {
        const response = await interaction;
        await ctx.client.notify(methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: JSON.stringify(response) }
          }
        });
      }
    }
    await ctx.client.notify(methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "report after interaction" }
      }
    });
    if (scenario === "late-after-seal") {
      setTimeout(() => {
        void ctx.client
          .notify(methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "late-final-update" }
            }
          })
          .catch(() => undefined);
      }, 5);
    }
    if (scenario.startsWith("late-")) {
      setTimeout(
        () => {
          void ctx.client
            .request(methods.client.session.requestPermission, {
              sessionId,
              toolCall: { toolCallId: "late-tool", title: "Late permission", kind: "read" },
              options: [{ optionId: "deny", name: "Deny", kind: "reject_once" }]
            })
            .then(
              () => {
                if (scenario === "late-after-seal") process.stderr.write("late request accepted\n");
              },
              () => {
                if (scenario === "late-after-seal") process.stderr.write("late request rejected\n");
              }
            );
        },
        scenario === "late-after-seal" ? 30 : 10
      );
    }
    return {
      stopReason: scenario.endsWith("cancelled") ? "cancelled" : "end_turn",
      ...(scenario === "late-usage"
        ? { usage: { totalTokens: 2, inputTokens: 1, outputTokens: 1 } }
        : {})
    };
  });

const connection = app.connect(
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
);
await connection.closed;
