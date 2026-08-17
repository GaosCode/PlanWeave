#!/usr/bin/env node
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolveExecutable } from "./acp-connection-reuse-gate/protocol-client.mjs";
import { parseArguments, profiles, thresholds } from "./acp-connection-reuse-gate/gate-config.mjs";
import { runBenchmark } from "./acp-connection-reuse-gate/benchmark-runner.mjs";
import {
  aggregateOutputSafety,
  decideGate,
  realProfileQualifies
} from "./acp-connection-reuse-gate/gate-evaluator.mjs";
import {
  createPrivateOutputTarget,
  writePrivateResult
} from "./acp-connection-reuse-gate/safe-output.mjs";
import { createClient as createRoutedClient } from "./acp-connection-reuse-gate/session-router.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mockAgent = join(repositoryRoot, "scripts/acp-connection-reuse-gate/mock-agent.mjs");

function createClient(options) {
  return createRoutedClient({ cwd: repositoryRoot, ...options });
}

const mockLaunch = {
  command: process.execPath,
  args: [mockAgent],
  reportsGateMetrics: true
};

async function initialize(item) {
  const response = await item.client.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { elicitation: { form: {} } },
    clientInfo: { name: "planweave-connection-reuse-gate", version: "1.0.0" }
  });
  return { response, spawnToInitializeMs: performance.now() - item.client.spawnStartedAt };
}

async function runMockConformance(stressIterations) {
  const primary = createClient({ launch: mockLaunch, env: process.env });
  try {
    const initialized = await initialize(primary);
    const first = primary.router.owner("first");
    const second = primary.router.owner("second");
    await primary.router.open(first);
    await primary.router.open(second);
    const concurrent = await Promise.all([
      primary.router.prompt(first, "first"),
      primary.router.prompt(second, "second")
    ]);
    const heldPrompt = primary.router.prompt(first, "hold");
    const survivingPrompt = primary.router.prompt(second, "during-cancel");
    await new Promise((resolve) => setTimeout(resolve, 20));
    primary.router.cancel(first);
    const [cancelled, survivedCancel] = await Promise.all([heldPrompt, survivingPrompt]);
    await primary.router.close(first);
    const survivor = await primary.router.prompt(second, "after-close");
    await primary.router.close(second);

    const basicChecks = {
      sessionCloseNegotiated:
        initialized.response?.agentCapabilities?.sessionCapabilities?.close != null,
      twoSessions: first.sessionId !== second.sessionId,
      earlyUpdates: [first, second].every((owner) =>
        owner.events.some((event) => event?.content?.text === `early:${owner.sessionId}`)
      ),
      sessionUpdates: [first, second].every((owner) =>
        owner.events.some((event) => event?.content?.text?.includes(`prompt:${owner.sessionId}:`))
      ),
      permissionCorrelation: [first, second].every((owner) =>
        owner.interactions.some(
          (interaction) =>
            interaction.kind === "permission" && interaction.sessionId === owner.sessionId
        )
      ),
      elicitationCorrelation: [first, second].every((owner) =>
        owner.interactions.some(
          (interaction) =>
            interaction.kind === "elicitation" && interaction.sessionId === owner.sessionId
        )
      ),
      uniqueRequestCorrelation:
        primary.router.interactionRequestIds.size ===
        first.interactions.length + second.interactions.length,
      concurrentPrompts: concurrent.every((result) => result?.stopReason === "end_turn"),
      singleSessionCancel:
        cancelled?.stopReason === "cancelled" && survivedCancel?.stopReason === "end_turn",
      singleSessionClose: survivor?.stopReason === "end_turn",
      failClosedDiagnostics: primary.router.diagnostics.length === 0
    };

    const stress = await runMockStress(stressIterations);
    const failure = await runMockConnectionFailure();
    const passed = Object.values(basicChecks).every(Boolean) && stress.passed && failure.passed;
    return { passed, checks: basicChecks, stress, connectionFailure: failure };
  } finally {
    await primary.client.dispose();
  }
}

async function runMockStress(iterations) {
  const item = createClient({ launch: mockLaunch, env: process.env });
  let crossSessionFailures = 0;
  let cancelledPrompts = 0;
  let survivingPrompts = 0;
  let failureRounds = 0;
  let automaticReplayCount = 0;
  try {
    await initialize(item);
    for (let index = 0; index < iterations; index += 1) {
      const first = item.router.owner(`stress-${index}-a`);
      const second = item.router.owner(`stress-${index}-b`);
      await item.router.open(first);
      await item.router.open(second);
      const firstPrompt = item.router.prompt(first, "hold");
      const secondPrompt = item.router.prompt(second, `stress-${index}-b`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      item.router.cancel(first);
      const results = await Promise.all([firstPrompt, secondPrompt]);
      if (results[0]?.stopReason === "cancelled") cancelledPrompts += 1;
      if (results[1]?.stopReason === "end_turn") survivingPrompts += 1;
      if (
        results[0]?.stopReason !== "cancelled" ||
        results[1]?.stopReason !== "end_turn" ||
        first.events.some((event) => event?.content?.text?.includes(second.sessionId)) ||
        second.events.some((event) => event?.content?.text?.includes(first.sessionId))
      ) {
        crossSessionFailures += 1;
      }
      await item.router.close(first);
      await item.router.close(second);
      if ((index + 1) % 10 === 0) {
        const failure = await runMockConnectionFailure();
        failureRounds += 1;
        if (failure.automaticReplay) automaticReplayCount += 1;
        if (!failure.passed) crossSessionFailures += 1;
      }
    }
    return {
      iterations,
      crossSessionFailures,
      cancelledPrompts,
      survivingPrompts,
      failureRounds,
      automaticReplayCount,
      pendingPromises: item.client.pendingCount,
      diagnostics: item.router.diagnostics.length,
      passed:
        crossSessionFailures === 0 &&
        cancelledPrompts === iterations &&
        survivingPrompts === iterations &&
        failureRounds === Math.floor(iterations / 10) &&
        automaticReplayCount === 0 &&
        item.client.pendingCount === 0 &&
        item.router.diagnostics.length === 0
    };
  } finally {
    await item.client.dispose();
  }
}

async function runMockConnectionFailure() {
  const item = createClient({ launch: mockLaunch, env: process.env });
  await initialize(item);
  const first = item.router.owner("fault-a");
  const second = item.router.owner("fault-b");
  await item.router.open(first);
  await item.router.open(second);
  const requestCountBefore = item.client.requestCounts.get("session/prompt") ?? 0;
  const prompts = [item.router.prompt(first, "hold"), item.router.prompt(second, "hold")];
  await new Promise((resolve) => setTimeout(resolve, 20));
  await item.client.terminateForFault();
  const settled = await Promise.allSettled(prompts);
  const promptRequestCount = item.client.requestCounts.get("session/prompt") ?? 0;
  const expectedPromptRequestCount = requestCountBefore + prompts.length;
  const automaticReplay = promptRequestCount !== expectedPromptRequestCount;
  return {
    affectedOwners: [first, second].filter((owner) => owner.lost === 1).length,
    rejectedPrompts: settled.filter((result) => result.status === "rejected").length,
    pendingPromises: item.client.pendingCount,
    promptRequestCount,
    expectedPromptRequestCount,
    automaticReplay,
    passed:
      settled.every((result) => result.status === "rejected") &&
      [first, second].every((owner) => owner.lost === 1) &&
      item.client.pendingCount === 0 &&
      !automaticReplay
  };
}

function safeRealEnvironment(paths) {
  const environment = {
    HOME: paths.home,
    XDG_CONFIG_HOME: paths.config,
    XDG_CACHE_HOME: paths.cache,
    XDG_DATA_HOME: paths.data,
    XDG_STATE_HOME: paths.state,
    PATH: process.env.PATH ?? "",
    TMPDIR: paths.temp,
    PWD: paths.workspace,
    LANG: process.env.LANG ?? "C.UTF-8"
  };
  if (process.platform === "win32" && process.env.SystemRoot) {
    environment.SystemRoot = process.env.SystemRoot;
  }
  return environment;
}

function classifyRealProbeError(error) {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("timed out")) return "operation-timeout";
  if (message.includes("process exited") || message.includes("failed to start")) {
    return "process-unavailable";
  }
  if (message.includes("session/new") || message.toLowerCase().includes("auth")) {
    return "authentication-or-session-setup-required";
  }
  return "safe-probe-failed";
}

async function probeRealProfile(profileName, rounds) {
  const definition = profiles[profileName];
  const executable = resolveExecutable(definition.command);
  if (!executable) {
    return { profile: profileName, status: "not-installed", hardConformance: false };
  }
  const probeStartedAt = Date.now();
  const deadlineAt = probeStartedAt + 20_000;
  const isolationRoot = mkdtempSync(join(tmpdir(), "planweave-acp-gate-"));
  const paths = Object.fromEntries(
    ["home", "config", "cache", "data", "state", "temp", "workspace"].map((name) => [
      name,
      join(isolationRoot, name)
    ])
  );
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const requestAudit = new Map();
  const launch = { command: executable, args: definition.args };
  const environment = safeRealEnvironment(paths);
  const item = createClient({
    launch,
    env: environment,
    cwd: paths.workspace,
    deadlineAt,
    timeoutMs: 20_000,
    requestAudit
  });
  let result;
  try {
    const initialized = await initialize(item);
    const closeNegotiated =
      initialized.response?.agentCapabilities?.sessionCapabilities?.close != null;
    if (!closeNegotiated) {
      result = {
        profile: profileName,
        status: "session-close-not-negotiated",
        sessionCloseNegotiated: closeNegotiated,
        sessionsOpened: 0,
        hardConformance: false,
        benchmark: { status: "not-measured" }
      };
    } else {
      const owners = Array.from(
        { length: thresholds.realMinimumSessionsPerConnection },
        (_, index) => item.router.owner(`real-${index + 1}`)
      );
      for (const owner of owners) await item.router.open(owner);
      item.router.cancel(owners[0]);
      for (const owner of owners) await item.router.close(owner);
      const sessions = new Set(owners.map((owner) => owner.sessionId));
      const safeProbePassed = sessions.size === thresholds.realMinimumSessionsPerConnection;
      const primaryCleanup = await item.client.dispose();
      const benchmark = safeProbePassed
        ? await runBenchmark({
            launch,
            env: environment,
            rounds,
            createClient,
            initialize,
            options: {
              cwd: paths.workspace,
              deadlineAt,
              requestAudit
            }
          })
        : { status: "not-measured", passed: false };
      result = {
        profile: profileName,
        status: safeProbePassed ? "safe-probe-passed" : "safe-probe-failed",
        sessionCloseNegotiated: closeNegotiated,
        sessionsOpened: sessions.size,
        checks: {
          initializeNewCloseCancel: safeProbePassed,
          openingAndEarlyUpdate: "not-measured-without-prompt",
          sessionUpdate: "not-measured-without-prompt",
          permissionElicitationCorrelation: "not-measured-without-prompt",
          connectionFailure: "not-measured-against-real-profile"
        },
        primaryProcessGroupCleanupConfirmed: primaryCleanup.processGroupCleanupConfirmed,
        hardConformance: false,
        benchmark
      };
    }
  } catch (error) {
    result = {
      profile: profileName,
      status: "unsupported",
      diagnostic: classifyRealProbeError(error),
      hardConformance: false,
      benchmark: { status: "not-measured" }
    };
  } finally {
    const cleanup = await item.client.dispose();
    result ??= {
      profile: profileName,
      status: "unsupported",
      diagnostic: "safe-probe-failed",
      hardConformance: false,
      benchmark: { status: "not-measured" }
    };
    result.deadlineMs = 20_000;
    result.elapsedMs = Date.now() - probeStartedAt;
    result.deadlineExceeded = result.elapsedMs > result.deadlineMs;
    result.processGroupCleanupConfirmed = cleanup.processGroupCleanupConfirmed;
    result.processTreeCleanupStatus =
      result.benchmark?.samples?.every(
        (sample) =>
          sample.dedicated.processTree.status === "measured-os" &&
          sample.shared.processTree.status === "measured-os"
      ) === true
        ? "process-group-reaped-and-descendants-observed"
        : "descendant-enumeration-not-measured";
    result.outputSafety = aggregateOutputSafety(
      item.client.outputSafety,
      result.benchmark?.outputSafety ?? {
        captureLimitExceeded: false,
        credentialShapeDetected: false,
        contentEmitted: false
      }
    );
    result.realProtocolRequestCounts = Object.fromEntries(requestAudit);
    result.isolation = {
      temporaryHome: true,
      temporaryXdg: true,
      temporaryProcessCwd: true,
      temporarySessionCwd: true,
      repositoryPathUsedAsCwd: false
    };
    if (cleanup.processGroupCleanupConfirmed)
      rmSync(isolationRoot, { recursive: true, force: true });
  }
  return result;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const outputTarget = options.output ? createPrivateOutputTarget() : null;
  const mock =
    options.mode === "real"
      ? null
      : {
          conformance: await runMockConformance(options.stress),
          benchmark: await runBenchmark({
            launch: mockLaunch,
            env: process.env,
            rounds: options.rounds,
            createClient,
            initialize
          })
        };
  const selectedProfiles = options.profiles.length > 0 ? options.profiles : Object.keys(profiles);
  const real = [];
  if (options.mode !== "mock") {
    for (const profile of selectedProfiles)
      real.push(await probeRealProfile(profile, options.rounds));
  }
  const qualifyingReal = real.filter(realProfileQualifies);
  const reasons = [];
  if (qualifyingReal.length === 0) {
    reasons.push("No real profile passed both hard conformance and the frozen benefit gate.");
  }
  if (real.length === 0) {
    reasons.push("Real-profile evidence was not measured; mock evidence cannot satisfy the gate.");
  }
  const totalRealRequests = (method) =>
    real.reduce((total, profile) => total + (profile.realProtocolRequestCounts?.[method] ?? 0), 0);
  const result = {
    version: "planweave.acp-connection-reuse-gate/v1",
    generatedAt: new Date().toISOString(),
    safety: {
      realPromptRequestsSent: totalRealRequests("session/prompt"),
      realAuthenticationRequestsSent: totalRealRequests("authenticate"),
      credentialEnvironmentForwarded: false,
      capturedOutputContentEmitted: false,
      credentialShapedOutputDetected: real.some(
        (profile) => profile.outputSafety?.credentialShapeDetected === true
      ),
      realProbeOperations: ["initialize", "session/new", "session/cancel", "session/close"]
    },
    thresholds,
    mock,
    real,
    decision: decideGate(real),
    reasons
  };
  if (outputTarget) result.rawOutputPath = outputTarget.filePath;
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (outputTarget) writePrivateResult(outputTarget, serialized);
  process.stdout.write(serialized);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
