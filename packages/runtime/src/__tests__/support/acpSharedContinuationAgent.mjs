import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const directory = process.argv[2];
const held = new Map();
let nextSession = 0;
const log = (event) => appendFileSync(join(directory, "protocol.log"), `${event}\n`);
const send = (message) => {
  const serialized = JSON.stringify({ jsonrpc: "2.0", ...message });
  appendFileSync(join(directory, "wire.log"), `${serialized}\n`);
  process.stdout.write(`${serialized}\n`);
};
const reply = (id, result) => send({ id, result });
const update = (sessionId, text) =>
  send({
    method: "session/update",
    params: {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } }
    }
  });
log(`spawn:${process.pid}`);
const interval = setInterval(() => {
  for (const [sessionId, id] of held) {
    if (existsSync(join(directory, "finish"))) {
      update(sessionId, "sibling-finished");
      reply(id, { stopReason: "end_turn" });
      held.delete(sessionId);
    }
  }
}, 10);
createInterface({ input: process.stdin })
  .on("line", async (line) => {
    const message = JSON.parse(line);
    const params = message.params ?? {};
    log(`${message.method}:${params.sessionId ?? ""}`);
    if (message.method === "initialize")
      reply(message.id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } },
        authMethods: []
      });
    if (message.method === "session/new") reply(message.id, { sessionId: `new-${++nextSession}` });
    if (message.method === "session/load") {
      if (params.sessionId === "fail-open") {
        send({ id: message.id, error: { code: -32000, message: "fixture load failure" } });
      } else {
        if (params.sessionId === "session-A") {
          while (existsSync(join(directory, "pause-A")))
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        if (params.sessionId === "flush-fail") update(params.sessionId, "early-failure");
        if (params.sessionId === "slow-open") {
          while (existsSync(join(directory, "pause-open")))
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        reply(message.id, {});
      }
    }
    if (message.method === "session/prompt") {
      const text = params.prompt[0]?.text;
      if (text === "hold") held.set(params.sessionId, message.id);
      else {
        update(params.sessionId, `answer:${text}`);
        for (const sessionId of held.keys()) update(sessionId, `sibling-during:${text}`);
        if (text === "fail")
          send({ id: message.id, error: { code: -32000, message: "fixture prompt failure" } });
        else reply(message.id, { stopReason: "end_turn" });
      }
    }
    if (message.method === "session/cancel" && held.has(params.sessionId)) {
      reply(held.get(params.sessionId), { stopReason: "cancelled" });
      held.delete(params.sessionId);
    }
    if (message.method === "session/close") reply(message.id, {});
    if (message.method === "session/set_mode") {
      if (params.modeId.startsWith("late:")) {
        const late = JSON.parse(params.modeId.slice(5));
        update(late.sessionId, late.text);
      }
      update(params.sessionId, params.modeId);
      reply(message.id, {});
    }
  })
  .on("close", () => {
    clearInterval(interval);
    log(`exit:${process.pid}`);
  });
