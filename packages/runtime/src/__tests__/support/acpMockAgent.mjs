#!/usr/bin/env node
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  PROTOCOL_VERSION,
  agent,
  methods,
  ndJsonStream,
  RequestError
} from "@agentclientprotocol/sdk";

function parseArgv(argv) {
  let scenario = "success";
  let controlDir = process.env.PLANWEAVE_ACP_TEST_CONTROL_DIR;
  let scenarioAssigned = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument.startsWith("--control-dir=")) {
      controlDir = argument.slice("--control-dir=".length);
      continue;
    }
    if (argument === "--control-dir") {
      controlDir = argv[index + 1];
      index += 1;
      continue;
    }
    if (!argument.startsWith("-") && !scenarioAssigned) {
      scenario = argument;
      scenarioAssigned = true;
    }
  }
  return { scenario, controlDir };
}

const { scenario, controlDir } = parseArgv(process.argv.slice(2));
const sessions = new Map();
let nextSession = 1;
let authenticated = false;
const lifecycleFile =
  process.env.PLANWEAVE_ACP_TEST_LIFECYCLE_FILE ??
  (controlDir ? join(controlDir, "lifecycle.log") : undefined);

function recordLifecycle(event) {
  if (lifecycleFile !== undefined) {
    appendFileSync(lifecycleFile, `${process.pid} ${event}\n`);
  }
}

function controlPath(name) {
  if (!controlDir) return undefined;
  return join(controlDir, name);
}

function takeControlFile(name) {
  const path = controlPath(name);
  if (!path || !existsSync(path)) return undefined;
  const content = readFileSync(path, "utf8");
  unlinkSync(path);
  return content;
}

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function spawnSignalIgnoringDescendant() {
  const child = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
    { stdio: "ignore" }
  );
  const path = controlPath("descendant-pid");
  if (path && child.pid) writeFileSync(path, `${child.pid}\n`, "utf8");
  child.unref();
}

/**
 * Harness-owned barrier: while `pause` exists under the control dir, ACP handlers block.
 * Optional `pause-at` file content lists method labels (newline/comma separated); when present,
 * only those methods pause. When `pause-at` is absent, every labeled checkpoint pauses.
 */
async function maybeBarrier(label) {
  const pauseFile = controlPath("pause");
  if (!pauseFile || !existsSync(pauseFile)) return;
  const pauseAtPath = controlPath("pause-at");
  if (pauseAtPath && existsSync(pauseAtPath)) {
    const targets = readFileSync(pauseAtPath, "utf8")
      .split(/[\n,]/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (targets.length > 0 && !targets.includes(label)) return;
  }
  recordLifecycle(`paused ${label}`);
  while (existsSync(pauseFile)) {
    const exitContent = takeControlFile("force-exit");
    if (exitContent !== undefined) {
      const code = Number.parseInt(exitContent.trim(), 10);
      process.exit(Number.isFinite(code) ? code : 42);
    }
    await pause(15);
  }
  recordLifecycle(`resumed ${label}`);
}

/** Emit one malformed NDJSON frame when harness drops `corrupt-next` into the control dir. */
function maybeCorruptStdout() {
  if (takeControlFile("corrupt-next") === undefined) return false;
  recordLifecycle("corrupt-next");
  process.stdout.write("{not-json-harness-corrupt}\n");
  return true;
}

if (controlDir) {
  mkdirSync(controlDir, { recursive: true });
  writeFileSync(join(controlDir, "ready"), `${process.pid}\n`, "utf8");
}

recordLifecycle("spawn");

if (scenario === "early-exit") {
  process.stderr.write("mock ACP exited before initialization\n");
  process.exit(23);
}

if (scenario === "private-overlong-process-error") {
  process.stderr.write(`/Users/private-worktree token=raw-secret ${"x".repeat(20_000)}\n`);
  process.exit(23);
}

if (scenario === "stderr") {
  process.stderr.write("mock ACP diagnostic\n");
}

if (scenario === "stderr-flood") {
  process.stderr.write("é".repeat(1024));
}

if (scenario === "stubborn-pending") {
  process.on("SIGTERM", () => process.stderr.write("SIGTERM observed\n"));
  setInterval(() => {}, 1_000);
}

if (scenario === "eof-delayed-exit") {
  const keepAlive = setInterval(() => undefined, 1_000);
  process.stdin.once("end", () => {
    recordLifecycle("EOF observed");
    setTimeout(() => {
      clearInterval(keepAlive);
      process.exit(0);
    }, 40);
  });
}

if (scenario === "term-exit-pending") {
  setInterval(() => undefined, 1_000);
  process.on("SIGTERM", () => {
    recordLifecycle("SIGTERM exit");
    process.exit(0);
  });
}

if (scenario === "root-exits-descendant-pending") {
  spawnSignalIgnoringDescendant();
  setInterval(() => undefined, 1_000);
  process.on("SIGTERM", () => {
    recordLifecycle("SIGTERM root exit");
    process.exit(0);
  });
}

const app = agent({ name: "planweave-acp-mock" })
  .onRequest(methods.agent.initialize, async (ctx) => {
    await maybeBarrier("initialize");
    maybeCorruptStdout();
    recordLifecycle("initialize");
    const elicitation = ctx.params.clientCapabilities?.elicitation;
    if (scenario === "expect-headless-capabilities" && elicitation != null) {
      throw RequestError.invalidParams({ reason: "headless client advertised elicitation" });
    }
    if (scenario === "expect-broker-capabilities" && elicitation?.form == null) {
      throw RequestError.invalidParams({ reason: "interactive broker omitted form elicitation" });
    }
    if (
      scenario === "delayed" ||
      scenario === "delayed-artifact-implementation" ||
      scenario === "load-capable-delayed"
    )
      await pause(40);
    if (scenario === "duplicate-response" || scenario === "unknown-id") {
      const id = scenario === "duplicate-response" ? ctx.requestId : "unknown-request-id";
      setTimeout(
        () =>
          process.stdout.write(
            `${JSON.stringify({ jsonrpc: "2.0", id, result: { duplicate: true } })}\n`
          ),
        10
      );
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession:
          scenario === "load-capable" ||
          scenario === "load-capable-error" ||
          scenario === "load-capable-delayed" ||
          scenario === "load-capable-stubborn-child" ||
          scenario === "recovery-permission-artifact",
        ...(scenario === "close-capable" ||
        scenario === "close-capable-error" ||
        scenario === "session-ready-with-agent-auth-close-pending"
          ? { sessionCapabilities: { close: {} } }
          : {})
      },
      authMethods:
        scenario === "grok-auth"
          ? [
              { id: "cached_token", name: "Cached token" },
              {
                id: "xai.api_key",
                name: "xAI API key",
                type: "env_var",
                vars: [{ name: "XAI_API_KEY", secret: true }]
              },
              { id: "grok.com", name: "Sign in with Grok" }
            ]
          : scenario === "grok-interactive"
            ? [{ id: "grok.com", name: "Sign in with Grok" }]
            : scenario === "auth-required" ||
                scenario === "action-required" ||
                scenario === "session-ready-with-agent-auth" ||
                scenario === "session-ready-with-agent-auth-close-pending" ||
                scenario === "authenticated-with-auth-methods" ||
                scenario === "authenticated-artifact-implementation" ||
                scenario === "authenticate-delayed" ||
                scenario === "authenticate-protocol-error" ||
                scenario === "env-auth"
              ? scenario === "env-auth"
                ? [
                    {
                      id: "env-login",
                      name: "Environment login",
                      type: "env_var",
                      vars: [{ name: "PLANWEAVE_T002_TEST_API_KEY", secret: true }],
                      _meta: { token: "mock-auth-meta-secret" }
                    },
                    {
                      id: "terminal-login",
                      name: "Terminal login",
                      type: "terminal",
                      args: ["login"],
                      env: { CUSTOM_AUTH_MATERIAL: "opaque-terminal-auth-material" },
                      _meta: { private: "opaque-private-auth-metadata" }
                    }
                  ]
                : [
                    {
                      id: "mock-login",
                      name: "Mock login",
                      description: "Test-only authentication"
                    }
                  ]
              : [],
      ...(scenario === "missing-agent-info"
        ? {}
        : {
            agentInfo: {
              name: "planweave-acp-mock",
              version:
                scenario === "missing-agent-version"
                  ? undefined
                  : scenario === "empty-agent-version"
                    ? ""
                    : scenario === "invalid-agent-version"
                      ? 31
                      : "1.0.0",
              ...(scenario === "extended-agent-info"
                ? {
                    title: null,
                    _meta: { vendor: "mock-vendor" },
                    futureExtension: { supported: true }
                  }
                : {})
            }
          })
    };
  })
  .onRequest(methods.agent.authenticate, async (ctx) => {
    recordLifecycle("authenticate");
    if (
      scenario !== "grok-auth" &&
      scenario !== "grok-interactive" &&
      scenario !== "auth-required" &&
      scenario !== "action-required" &&
      scenario !== "authenticated-with-auth-methods" &&
      scenario !== "authenticated-artifact-implementation" &&
      scenario !== "authenticate-delayed" &&
      scenario !== "authenticate-protocol-error" &&
      scenario !== "env-auth"
    ) {
      throw RequestError.invalidParams({ reason: "authentication was not advertised" });
    }
    const expectedMethodId =
      scenario === "grok-auth"
        ? process.env.XAI_API_KEY === undefined
          ? "cached_token"
          : "xai.api_key"
        : scenario === "grok-interactive"
          ? "grok.com"
          : scenario === "env-auth"
            ? "env-login"
            : "mock-login";
    if (ctx.params.methodId !== expectedMethodId) {
      throw RequestError.invalidParams({ methodId: ctx.params.methodId });
    }
    if (scenario === "env-auth" && process.env.PLANWEAVE_T002_TEST_API_KEY === undefined) {
      throw RequestError.invalidParams({ reason: "test credential was not present in spawn env" });
    }
    if (scenario === "authenticate-delayed") await pause(5_000);
    if (scenario === "authenticate-protocol-error") {
      throw RequestError.invalidParams({ reason: "scripted authentication failure" });
    }
    authenticated = true;
    return {};
  })
  .onRequest(methods.agent.session.new, async () => {
    await maybeBarrier("session/new");
    maybeCorruptStdout();
    recordLifecycle("session/new");
    if (scenario === "action-required" && !authenticated) {
      throw RequestError.invalidParams({ reason: "session/new must not run before user action" });
    }
    if (scenario === "auth-required" && !authenticated) {
      throw RequestError.authRequired();
    }
    if (
      (scenario === "grok-auth" ||
        scenario === "grok-interactive" ||
        scenario === "authenticated-with-auth-methods" ||
        scenario === "authenticated-artifact-implementation" ||
        scenario === "authenticate-delayed" ||
        scenario === "authenticate-protocol-error" ||
        scenario === "env-auth") &&
      !authenticated
    ) {
      throw RequestError.authRequired();
    }
    if (scenario === "single-session" && sessions.size >= 1) {
      throw RequestError.invalidParams({ reason: "agent supports only one session" });
    }
    if (scenario === "no-auth-methods-but-session-requires-auth") {
      throw RequestError.authRequired();
    }
    if (scenario === "generic-server-error") {
      throw new RequestError(-32000, "Provider request failed");
    }
    if (scenario === "invalid-envelope-pending" || scenario === "invalid-object-envelope-pending") {
      await pause(100);
    }
    if (scenario === "oversized-frame") {
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "oversized-session",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "é".repeat(600) }
            }
          }
        })}\n`
      );
      await pause(100);
    }
    const sessionId = `mock-session-${nextSession++}`;
    const currentModeId =
      scenario === "probe-session-config-current-second" ? "agent-full-access" : "read-only";
    const currentModel =
      scenario === "probe-session-config-current-second" ? "gpt-5.2-codex" : "gpt-5";
    sessions.set(sessionId, {
      cancelled: false,
      modeId: currentModeId,
      config: { model: currentModel, "fast-mode": false }
    });
    if (scenario === "early-session-update") {
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "update before session/new response" }
            }
          }
        })}\n`
      );
    }
    return scenario === "artifact-session-config" ||
      scenario === "artifact-session-config-live" ||
      scenario === "probe-session-config-current-second"
      ? {
          sessionId,
          modes: {
            currentModeId,
            availableModes: [
              { id: "read-only", name: "Read only" },
              { id: "agent-full-access", name: "Agent full access" }
            ]
          },
          configOptions: [
            {
              id: "model",
              type: "select",
              name: "Model",
              category: "model",
              currentValue: currentModel,
              options: [
                { value: "gpt-5", name: "GPT-5" },
                { value: "gpt-5.2-codex", name: "GPT-5.2 Codex" }
              ]
            },
            {
              id: "fast-mode",
              type: "boolean",
              name: "Fast mode",
              currentValue: false
            }
          ]
        }
      : { sessionId };
  })
  .onRequest(methods.agent.session.load, async (ctx) => {
    recordLifecycle("session/load");
    if (
      scenario !== "load-capable" &&
      scenario !== "load-capable-error" &&
      scenario !== "load-capable-delayed" &&
      scenario !== "load-capable-stubborn-child" &&
      scenario !== "recovery-permission-artifact"
    ) {
      throw RequestError.invalidParams({ sessionId: ctx.params.sessionId });
    }
    sessions.set(ctx.params.sessionId, { cancelled: false, recovered: true });
    await ctx.client.notify(methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "replayed-message",
        content: { type: "text", text: "historical replay" }
      }
    });
    return {};
  })
  .onNotification(methods.agent.session.cancel, (ctx) => {
    const session = sessions.get(ctx.params.sessionId);
    if (session) session.cancelled = true;
  })
  .onRequest(methods.agent.session.close, async (ctx) => {
    recordLifecycle("session/close");
    if (scenario === "session-ready-with-agent-auth-close-pending") {
      await new Promise(() => undefined);
    }
    if (scenario === "close-capable-error") {
      throw RequestError.invalidParams({ reason: "scripted close failure" });
    }
    if (!sessions.delete(ctx.params.sessionId)) {
      throw RequestError.invalidParams({ sessionId: ctx.params.sessionId });
    }
    return {};
  })
  .onRequest(methods.agent.session.setMode, (ctx) => {
    const session = sessions.get(ctx.params.sessionId);
    if (!session) throw RequestError.invalidParams({ sessionId: ctx.params.sessionId });
    session.modeId = ctx.params.modeId;
    return {};
  })
  .onRequest(methods.agent.session.setConfigOption, (ctx) => {
    const session = sessions.get(ctx.params.sessionId);
    if (!session) throw RequestError.invalidParams({ sessionId: ctx.params.sessionId });
    session.config[ctx.params.configId] = ctx.params.value;
    return {
      configOptions: [
        {
          id: "model",
          type: "select",
          name: "Model",
          category: "model",
          currentValue: session.config.model,
          options: [
            { value: "gpt-5", name: "GPT-5" },
            { value: "gpt-5.2-codex", name: "GPT-5.2 Codex" }
          ]
        },
        {
          id: "fast-mode",
          type: "boolean",
          name: "Fast mode",
          currentValue: session.config["fast-mode"]
        }
      ]
    };
  })
  .onRequest(methods.agent.session.prompt, async (ctx) => {
    await maybeBarrier("session/prompt");
    maybeCorruptStdout();
    recordLifecycle("session/prompt");
    const { sessionId } = ctx.params;
    const session = sessions.get(sessionId);
    if (!session) throw RequestError.invalidParams({ sessionId });
    if (scenario === "slow-prompt") {
      for (let i = 0; i < 20 && !session.cancelled; i += 1) {
        await pause(20);
      }
    }
    if (
      scenario === "artifact-session-config" &&
      (session.modeId !== "agent-full-access" ||
        session.config.model !== "gpt-5.2-codex" ||
        session.config["fast-mode"] !== true)
    ) {
      throw RequestError.invalidParams({ reason: "ACP session defaults were not applied" });
    }
    if (scenario === "load-capable-error") {
      throw RequestError.invalidParams({ reason: "scripted continuation error" });
    }
    if (scenario === "protocol-error")
      throw RequestError.invalidParams({ reason: "scripted protocol error" });
    if (
      scenario === "stubborn-pending" ||
      scenario === "term-exit-pending" ||
      scenario === "root-exits-descendant-pending"
    ) {
      await ctx.client.request("mock/pending", { sessionId });
    }
    if (scenario === "load-capable-stubborn-child") {
      spawnSignalIgnoringDescendant();
      recordLifecycle("stubborn prompt");
      await new Promise(() => undefined);
    }

    const promptText = ctx.params.prompt.find((part) => part.type === "text")?.text ?? "";
    const taskPrompt = promptText.split("\n\nPLANWEAVE RUNNER-ONLY FINAL ARTIFACT CONTRACT", 1)[0];
    const artifactScenario =
      scenario.startsWith("artifact-") ||
      scenario === "authenticated-artifact-implementation" ||
      scenario === "env-auth" ||
      scenario === "delayed-artifact-implementation" ||
      scenario === "terminal-output" ||
      scenario === "permission-deny" ||
      scenario === "permission-secret" ||
      scenario === "elicitation-secret" ||
      scenario === "elicitation-validation" ||
      scenario === "multi-interaction" ||
      scenario === "artifact-session-config" ||
      scenario === "artifact-session-config-live" ||
      scenario === "recovery-permission-artifact";
    if (
      artifactScenario &&
      (!promptText.includes("PLANWEAVE RUNNER-ONLY FINAL ARTIFACT CONTRACT") ||
        !promptText.includes("PLANWEAVE_FINAL_ARTIFACT "))
    ) {
      throw RequestError.invalidParams({ reason: "missing runner final-artifact instruction" });
    }

    const artifactText =
      scenario === "recovery-permission-artifact"
        ? session.recovered !== true
          ? `PLANWEAVE_FINAL_ARTIFACT ${JSON.stringify({ version: "planweave.runner-artifact/v1", artifact: { kind: "review", ref: "T-001#R-001", taskId: "T-001", reviewResult: { reviewBlockRef: "T-001#R-001", taskId: "T-001", verdict: "passed", content: "passed" } } })}\n`
          : `PLANWEAVE_FINAL_ARTIFACT ${JSON.stringify({ version: "planweave.runner-artifact/v1", artifact: { kind: "implementation", ref: "T-001#B-001", taskId: "T-001", reportMarkdown: "recovered implementation\n" } })}\n`
        : scenario === "artifact-implementation" ||
            scenario === "authenticated-artifact-implementation" ||
            scenario === "env-auth" ||
            scenario === "artifact-session-config" ||
            scenario === "artifact-session-config-live" ||
            scenario === "delayed-artifact-implementation" ||
            scenario === "terminal-output" ||
            scenario === "permission-deny" ||
            scenario === "permission-secret" ||
            scenario === "elicitation-secret" ||
            scenario === "elicitation-validation" ||
            scenario === "multi-interaction"
          ? `PLANWEAVE_FINAL_ARTIFACT ${JSON.stringify({ version: "planweave.runner-artifact/v1", artifact: { kind: "implementation", ref: "T-001#B-001", taskId: "T-001", reportMarkdown: "implemented\n" } })}\n`
          : scenario === "artifact-review" || scenario === "artifact-review-needs-changes"
            ? `PLANWEAVE_FINAL_ARTIFACT ${JSON.stringify({ version: "planweave.runner-artifact/v1", artifact: { kind: "review", ref: "T-001#R-001", taskId: "T-001", reviewResult: { reviewBlockRef: "T-001#R-001", taskId: "T-001", verdict: scenario === "artifact-review-needs-changes" ? "needs_changes" : "passed", content: scenario === "artifact-review-needs-changes" ? "fix the implementation" : "passed" } } })}\n`
            : scenario === "artifact-feedback"
              ? `PLANWEAVE_FINAL_ARTIFACT ${JSON.stringify({ version: "planweave.runner-artifact/v1", artifact: { kind: "feedback", feedbackId: "FE-001", sourceReviewBlockRef: "T-001#R-001", taskId: "T-001", reportMarkdown: "feedback fixed\n" } })}\n`
              : scenario === "nontext-output"
                ? "TOKEN=super-secret"
                : `hello from ${sessionId}`;
    await ctx.client.notify(methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: artifactText }
      }
    });
    if (scenario === "nontext-output") {
      await ctx.client.notify(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "image", mimeType: "image/png", data: "AAAA" }
        }
      });
    }

    if (scenario === "artifact-session-config-live") {
      await ctx.client.notify(methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: "current_mode_update", currentModeId: "agent-full-access" }
      });
      await ctx.client.notify(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [
            {
              id: "model",
              type: "select",
              name: "Model",
              category: "model",
              currentValue: "gpt-5.2-codex",
              options: [
                { value: "gpt-5", name: "GPT-5" },
                { value: "gpt-5.2-codex", name: "GPT-5.2 Codex" }
              ]
            },
            {
              id: "reasoning_effort",
              type: "select",
              name: "Reasoning effort",
              category: "thought_level",
              currentValue: "high",
              options: [{ value: "high", name: "High" }]
            }
          ]
        }
      });
    }

    if (
      scenario === "streaming" ||
      scenario === "permission" ||
      scenario === "permission-deny" ||
      scenario === "permission-secret" ||
      scenario === "recovery-permission-artifact"
    ) {
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

    if (
      scenario === "permission" ||
      scenario === "permission-deny" ||
      scenario === "permission-secret" ||
      scenario === "recovery-permission-artifact"
    ) {
      const permission = await ctx.client.request(methods.client.session.requestPermission, {
        sessionId,
        toolCall: { toolCallId: `tool-${sessionId}`, title: "Inspect fixture", kind: "read" },
        options:
          scenario === "permission-deny"
            ? [{ optionId: "deny", name: "Deny", kind: "reject_once" }]
            : scenario === "permission-secret"
              ? [
                  {
                    optionId: "token=opaque-action-id",
                    name: "password=super-secret",
                    kind: "allow_once"
                  }
                ]
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
          toolCall: {
            toolCallId: `tool-${sessionId}`,
            title: "Concurrent permission",
            kind: "read"
          },
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

    if (
      scenario === "elicitation" ||
      scenario === "unsupported-elicitation" ||
      scenario === "elicitation-secret" ||
      scenario === "engine-elicitation-secret"
    ) {
      await ctx.client.request(methods.client.elicitation.create, {
        mode: scenario === "unsupported-elicitation" ? "url" : "form",
        sessionId,
        message:
          scenario === "elicitation-secret" || scenario === "engine-elicitation-secret"
            ? "Authorization: Bearer secret-token"
            : "Choose a test value",
        ...(scenario === "unsupported-elicitation"
          ? { url: "https://example.invalid", elicitationId: "unsupported-1" }
          : {}),
        requestedSchema: {
          type: "object",
          properties: {
            value: {
              type: "string",
              title: "Value",
              ...(scenario === "elicitation-secret" || scenario === "engine-elicitation-secret"
                ? { default: "api_key=raw-secret" }
                : {})
            }
          },
          required: ["value"]
        }
      });
    }

    if (scenario === "elicitation-validation") {
      const schemas = {
        required: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"]
        },
        enum: {
          type: "object",
          properties: { value: { type: "string", enum: ["alpha", "beta"] } },
          required: ["value"]
        },
        oneOf: {
          type: "object",
          properties: {
            value: {
              type: "string",
              oneOf: [
                { const: "alpha", title: "Alpha" },
                { const: "beta", title: "Beta" }
              ]
            }
          },
          required: ["value"]
        },
        range: {
          type: "object",
          properties: { value: { type: "number", minimum: 1, maximum: 5 } },
          required: ["value"]
        },
        integer: {
          type: "object",
          properties: { value: { type: "integer", minimum: 1, maximum: 5 } },
          required: ["value"]
        },
        string: {
          type: "object",
          properties: {
            value: {
              type: "string",
              minLength: 6,
              maxLength: 32,
              pattern: "^[^@]+@[^@]+$",
              format: "email"
            }
          },
          required: ["value"]
        },
        multi: {
          type: "object",
          properties: {
            value: {
              type: "array",
              items: { type: "string", enum: ["alpha", "beta", "gamma"] },
              minItems: 1,
              maxItems: 2
            }
          },
          required: ["value"]
        },
        "multi-titled": {
          type: "object",
          properties: {
            value: {
              type: "array",
              items: {
                anyOf: [
                  { const: "alpha", title: "Alpha" },
                  { const: "beta", title: "Beta" }
                ]
              },
              minItems: 1,
              maxItems: 2
            }
          },
          required: ["value"]
        },
        unsupported: {
          type: "object",
          properties: { value: { type: "future-preview-type" } }
        }
      };
      await ctx.client.request(methods.client.elicitation.create, {
        mode: "form",
        sessionId,
        message: `Validate ${taskPrompt}`,
        requestedSchema: schemas[taskPrompt] ?? schemas.required
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
    if (
      scenario === "delayed" ||
      scenario === "delayed-artifact-implementation" ||
      scenario === "late-update"
    )
      await pause(40);
    if (scenario === "late-update") {
      await ctx.client.notify(methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late" } }
      });
    }
    const scriptedStopReason =
      scenario === "refusal" || scenario === "max_tokens" || scenario === "max_turn_requests"
        ? scenario
        : "end_turn";
    return {
      stopReason: session.cancelled ? "cancelled" : scriptedStopReason,
      ...(scenario === "prompt-usage"
        ? {
            usage: {
              totalTokens: 15,
              inputTokens: 9,
              outputTokens: 6,
              thoughtTokens: 2,
              cachedReadTokens: 3
            }
          }
        : {})
    };
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
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: 1, id: 7, result: {} })}\n`),
    20
  );
}

await connection.closed;
