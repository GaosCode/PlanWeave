import { appendFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
const [log, mode, authReleasePath] = process.argv.slice(2);
const record = (event) => appendFileSync(log, `${event}\n`);
const keepAlive = setInterval(() => undefined, 1000);
let promptId;
const reply = (id, result) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
process.on("SIGTERM", () => {
  record("term");
  if (mode !== "force") process.exit(0);
});
process.stdin.on("end", () => {
  record("eof");
  if (mode === "responsive")
    setTimeout(() => {
      clearInterval(keepAlive);
      process.exit(0);
    }, 60);
});
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (mode === "initializing") record("initialize");
    else
      reply(message.id, {
        protocolVersion: 1,
        agentCapabilities: mode === "loading" ? { loadSession: true } : {},
        ...(mode === "authenticating"
          ? { authMethods: [{ id: "env", name: "Env", type: "env_var", vars: [] }] }
          : {})
      });
  }
  if (message.method === "authenticate") {
    record("auth");
    if (authReleasePath) {
      const waiting = setInterval(() => {
        if (existsSync(authReleasePath)) {
          clearInterval(waiting);
          reply(message.id, {});
        }
      }, 5);
    }
  }
  if (message.method === "session/load") record("load");
  if (message.method === "session/new") reply(message.id, { sessionId: "cancel-session" });
  if (message.method === "session/prompt") {
    promptId = message.id;
    record("prompt");
    if (mode === "authenticating") reply(promptId, { stopReason: "end_turn" });
  }
  if (message.method === "session/cancel") {
    record("cancel");
    if (mode === "responsive") reply(promptId, { stopReason: "cancelled" });
  }
});
