import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  runnerInteractionOwnerResultSchema,
  runnerPermissionInteractionRequestSchema,
  runnerPermissionInteractionResponseSchema
} from "../autoRun/runnerInteractionContract.js";
import { PersistentRunnerInteractionStore } from "../autoRun/runnerInteractionStore.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function createRunDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "planweave-interaction-store-"));
  temporaryRoots.push(root);
  const runDir = join(root, "runs", "RUN-001");
  await mkdir(runDir, { recursive: true });
  return runDir;
}

function requestFixture(overrides: Record<string, unknown> = {}) {
  return runnerPermissionInteractionRequestSchema.parse({
    version: "planweave.runner-interaction/v1",
    kind: "permission",
    identity: {
      projectId: "project-1",
      canvasId: "default",
      claimRef: "T-001#B-001",
      executorRunId: "RUN-001",
      sessionId: "session-1",
      requestId: "permission:1",
      ownerLeaseId: "b3cbd2b7-e1ca-4e7b-b9a2-39a9b6707395",
      ownerGeneration: 1
    },
    requestedAt: "2026-07-17T04:00:00.000Z",
    summary: "Run focused tests",
    toolCallId: "tool=/../测试?call",
    options: [
      { optionId: "allow=once/../✓", label: "Allow once", decision: "approve" },
      { optionId: "reject once?", label: "Reject", decision: "deny" }
    ],
    ...overrides
  });
}

function responseFixture(
  request = requestFixture(),
  optionId = "allow=once/../✓",
  source = "test-client"
) {
  return runnerPermissionInteractionResponseSchema.parse({
    version: "planweave.runner-interaction-response/v1",
    identity: request.identity,
    decision: { kind: "select", optionId },
    respondedAt: "2026-07-17T04:01:00.000Z",
    decisionSource: source,
    reason: null
  });
}

function ownerResultFixture(
  request = requestFixture(),
  reason: "deadline" | "aborted" = "deadline"
) {
  return runnerInteractionOwnerResultSchema.parse({
    version: "planweave.runner-interaction-owner-result/v1",
    identity: request.identity,
    outcome: "expired",
    reason,
    recordedAt: "2026-07-17T04:01:00.000Z",
    message: `Permission request expired: ${reason}.`
  });
}

function interactionDir(runDir: string, requestId = "permission:1"): string {
  return join(runDir, "interactions", Buffer.from(requestId).toString("base64url"));
}

describe("persistent runner interaction store", () => {
  it("round-trips immutable requests and responses with private canonical modes", async () => {
    const runDir = await createRunDir();
    const store = new PersistentRunnerInteractionStore(runDir);
    const request = requestFixture();

    const pending = await store.createRequest(request);
    expect(pending).toMatchObject({ status: "pending", response: null });
    await expect(store.createRequest(request)).resolves.toEqual(pending);

    const receipt = await store.createResponse(responseFixture(request));
    expect(receipt).toMatchObject({
      acceptedAt: "2026-07-17T04:01:00.000Z",
      selectedOption: { optionId: "allow=once/../✓", decision: "approve" }
    });
    await expect(store.readSnapshot("permission:1")).resolves.toMatchObject({
      status: "answered",
      response: { decisionSource: "test-client" }
    });
    await expect(store.listSnapshots()).resolves.toHaveLength(1);

    const directoryMode = (await lstat(interactionDir(runDir))).mode & 0o777;
    const requestMode = (await lstat(join(interactionDir(runDir), "request.json"))).mode & 0o777;
    const responseMode = (await lstat(join(interactionDir(runDir), "response.json"))).mode & 0o777;
    const settlementMode =
      (await lstat(join(interactionDir(runDir), "settlement.json"))).mode & 0o777;
    expect(directoryMode).toBe(0o700);
    expect(requestMode).toBe(0o600);
    expect(responseMode).toBe(0o600);
    expect(settlementMode).toBe(0o600);
  });

  it("reports immutable request conflict, response conflict, identity mismatch, and invalid option", async () => {
    const runDir = await createRunDir();
    const store = new PersistentRunnerInteractionStore(runDir);
    const request = requestFixture();
    await store.createRequest(request);

    await expect(
      store.createRequest(requestFixture({ summary: "A different immutable request" }))
    ).rejects.toMatchObject({ code: "interaction_request_conflict" });
    await expect(
      store.createResponse(responseFixture(request, "invented_allow"))
    ).rejects.toMatchObject({ code: "interaction_option_not_advertised" });
    const mismatched = runnerPermissionInteractionResponseSchema.parse({
      ...responseFixture(request),
      identity: { ...request.identity, sessionId: "different-session" }
    });
    await expect(store.createResponse(mismatched)).rejects.toMatchObject({
      code: "interaction_identity_mismatch"
    });

    await store.createResponse(responseFixture(request));
    await expect(
      store.createResponse(responseFixture(request, "reject once?", "second-client"))
    ).rejects.toMatchObject({
      code: "interaction_already_answered",
      details: {
        respondedAt: "2026-07-17T04:01:00.000Z",
        decisionSource: "test-client"
      }
    });
  });

  it("validates owner results immediately and keeps duplicate content idempotent", async () => {
    const runDir = await createRunDir();
    const store = new PersistentRunnerInteractionStore(runDir);
    const request = requestFixture();
    await store.createRequest(request);
    const ownerResult = ownerResultFixture(request);

    await expect(store.createOwnerResult(ownerResult)).resolves.toEqual(ownerResult);
    await expect(store.createOwnerResult(ownerResult)).resolves.toEqual(ownerResult);
    await expect(
      store.createOwnerResult(ownerResultFixture(request, "aborted"))
    ).rejects.toMatchObject({
      code: "interaction_already_answered",
      details: { winnerKind: "owner_result" }
    });
    await expect(store.readSnapshot(request.identity.requestId)).resolves.toMatchObject({
      status: "expired",
      response: null,
      ownerResult
    });
  });

  it("rejects corrupted or mismatched canonical owner results during createOwnerResult", async () => {
    const corruptedRunDir = await createRunDir();
    const corruptedStore = new PersistentRunnerInteractionStore(corruptedRunDir);
    const request = requestFixture();
    await corruptedStore.createRequest(request);
    const corruptedPath = join(interactionDir(corruptedRunDir), "owner-result.json");
    await writeFile(corruptedPath, "{broken json\n", { encoding: "utf8", mode: 0o600 });
    await expect(
      corruptedStore.createOwnerResult(ownerResultFixture(request))
    ).rejects.toMatchObject({
      code: "interaction_contract_invalid"
    });

    const mismatchRunDir = await createRunDir();
    const mismatchStore = new PersistentRunnerInteractionStore(mismatchRunDir);
    await mismatchStore.createRequest(request);
    const mismatchPath = join(interactionDir(mismatchRunDir), "owner-result.json");
    await writeFile(
      mismatchPath,
      `${JSON.stringify({
        ...ownerResultFixture(request),
        identity: { ...request.identity, ownerGeneration: 2 }
      })}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
    await expect(
      mismatchStore.createOwnerResult(ownerResultFixture(request))
    ).rejects.toMatchObject({
      code: "interaction_identity_mismatch"
    });
  });

  it("settles response and owner result conflicts in both directions", async () => {
    const responseRunDir = await createRunDir();
    const responseStore = new PersistentRunnerInteractionStore(responseRunDir);
    const responseRequest = requestFixture();
    await responseStore.createRequest(responseRequest);
    await responseStore.createResponse(responseFixture(responseRequest));
    await expect(
      responseStore.createOwnerResult(ownerResultFixture(responseRequest))
    ).rejects.toMatchObject({
      code: "interaction_already_answered",
      details: { winnerKind: "response" }
    });

    const ownerRunDir = await createRunDir();
    const ownerStore = new PersistentRunnerInteractionStore(ownerRunDir);
    const ownerRequest = requestFixture();
    await ownerStore.createRequest(ownerRequest);
    await ownerStore.createOwnerResult(ownerResultFixture(ownerRequest));
    await expect(ownerStore.createResponse(responseFixture(ownerRequest))).rejects.toMatchObject({
      code: "interaction_already_answered",
      details: { winnerKind: "owner_result" }
    });
  });

  it("fails explicitly for corrupted JSON, old versions, and mismatched persisted identity", async () => {
    const runDir = await createRunDir();
    const store = new PersistentRunnerInteractionStore(runDir);
    const request = requestFixture();
    await store.createRequest(request);
    const requestPath = join(interactionDir(runDir), "request.json");

    await writeFile(requestPath, "{broken json\n", "utf8");
    await expect(store.readSnapshot("permission:1")).rejects.toMatchObject({
      code: "interaction_contract_invalid"
    });

    await writeFile(
      requestPath,
      `${JSON.stringify({ ...request, version: "planweave.runner-interaction/v0" })}\n`,
      "utf8"
    );
    await expect(store.readSnapshot("permission:1")).rejects.toMatchObject({
      code: "interaction_contract_invalid"
    });

    await writeFile(requestPath, `${JSON.stringify(request)}\n`, "utf8");
    const responsePath = join(interactionDir(runDir), "response.json");
    await writeFile(
      responsePath,
      `${JSON.stringify({
        ...responseFixture(request),
        version: "planweave.runner-interaction-response/v0"
      })}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
    await chmod(responsePath, 0o600);
    await expect(store.readSnapshot("permission:1")).rejects.toMatchObject({
      code: "interaction_contract_invalid"
    });

    await writeFile(
      responsePath,
      `${JSON.stringify({
        ...responseFixture(request),
        identity: { ...request.identity, ownerGeneration: 2 }
      })}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
    await chmod(responsePath, 0o600);
    await expect(store.readSnapshot("permission:1")).rejects.toMatchObject({
      code: "interaction_identity_mismatch"
    });

    await writeFile(
      responsePath,
      `${JSON.stringify(responseFixture(request, "not advertised=/../option"))}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
    await chmod(responsePath, 0o600);
    await expect(store.readSnapshot("permission:1")).rejects.toMatchObject({
      code: "interaction_option_not_advertised"
    });
    await expect(store.listSnapshots()).rejects.toMatchObject({
      code: "interaction_option_not_advertised"
    });
    await expect(store.createResponse(responseFixture(request))).rejects.toMatchObject({
      code: "interaction_option_not_advertised"
    });
  });

  it("ignores interrupted temporary files and never treats them as canonical responses", async () => {
    const runDir = await createRunDir();
    const store = new PersistentRunnerInteractionStore(runDir);
    const request = requestFixture();
    await store.createRequest(request);
    await writeFile(
      join(interactionDir(runDir), ".interaction.interrupted.tmp"),
      `${JSON.stringify(responseFixture(request))}\n`,
      { encoding: "utf8", mode: 0o600 }
    );

    await expect(store.readSnapshot("permission:1")).resolves.toMatchObject({
      status: "pending",
      response: null
    });
  });

  it("rejects traversal-shaped ids and symlink escapes", async () => {
    const runDir = await createRunDir();
    const outside = await mkdtemp(join(tmpdir(), "planweave-interaction-outside-"));
    temporaryRoots.push(outside);
    const store = new PersistentRunnerInteractionStore(runDir);

    await expect(Reflect.apply(store.readSnapshot, store, ["../../outside"])).rejects.toMatchObject(
      { code: "interaction_path_invalid" }
    );

    await symlink(outside, join(runDir, "interactions"), "dir");
    await expect(store.createRequest(requestFixture())).rejects.toMatchObject({
      code: "interaction_path_unsafe"
    });
    await expect(readFile(join(outside, "request.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("rejects an interaction-directory symlink and non-private canonical files", async () => {
    const runDir = await createRunDir();
    const outside = await mkdtemp(join(tmpdir(), "planweave-interaction-outside-"));
    temporaryRoots.push(outside);
    await mkdir(join(runDir, "interactions"), { mode: 0o700 });
    await symlink(outside, interactionDir(runDir), "dir");
    const store = new PersistentRunnerInteractionStore(runDir);

    await expect(store.readSnapshot("permission:1")).rejects.toMatchObject({
      code: "interaction_path_unsafe"
    });

    await rm(interactionDir(runDir));
    await store.createRequest(requestFixture());
    await chmod(join(interactionDir(runDir), "request.json"), 0o644);
    await expect(store.readSnapshot("permission:1")).rejects.toMatchObject({
      code: "interaction_path_unsafe"
    });
  });

  it.skipIf(process.platform === "win32")(
    "fails closed when existing interaction directory permissions drift",
    async () => {
      const runDir = await createRunDir();
      const store = new PersistentRunnerInteractionStore(runDir);
      const request = requestFixture();
      await store.createRequest(request);
      const interactionsDir = join(runDir, "interactions");
      const requestDir = interactionDir(runDir);

      await chmod(interactionsDir, 0o755);
      await expect(store.listSnapshots()).rejects.toMatchObject({
        code: "interaction_path_unsafe"
      });
      await expect(store.readSnapshot("permission:1")).rejects.toMatchObject({
        code: "interaction_path_unsafe"
      });
      await expect(store.createResponse(responseFixture(request))).rejects.toMatchObject({
        code: "interaction_path_unsafe"
      });
      await expect(store.createRequest(request)).rejects.toMatchObject({
        code: "interaction_path_unsafe"
      });
      expect((await lstat(interactionsDir)).mode & 0o777).toBe(0o755);

      await chmod(interactionsDir, 0o700);
      await chmod(requestDir, 0o755);
      await expect(store.listSnapshots()).rejects.toMatchObject({
        code: "interaction_path_unsafe"
      });
      await expect(store.readSnapshot("permission:1")).rejects.toMatchObject({
        code: "interaction_path_unsafe"
      });
      await expect(store.createResponse(responseFixture(request))).rejects.toMatchObject({
        code: "interaction_path_unsafe"
      });
      await expect(store.createRequest(request)).rejects.toMatchObject({
        code: "interaction_path_unsafe"
      });
      expect((await lstat(requestDir)).mode & 0o777).toBe(0o755);
    }
  );

  it("keeps old run directories without an interaction mailbox readable as an empty list", async () => {
    const store = new PersistentRunnerInteractionStore(await createRunDir());
    await expect(store.listSnapshots()).resolves.toEqual([]);
  });

  it("allows exactly one response across two real child processes", async () => {
    const runDir = await createRunDir();
    const store = new PersistentRunnerInteractionStore(runDir);
    const request = requestFixture();
    await store.createRequest(request);
    const modulePath = pathToFileURL(
      join(dirname(fileURLToPath(import.meta.url)), "../autoRun/runnerInteractionStore.ts")
    ).href;
    const childSource = `
      import { PersistentRunnerInteractionStore, RunnerInteractionStoreError } from ${JSON.stringify(modulePath)};
      const [runDir, encodedResponse] = process.argv.slice(-2);
      try {
        const receipt = await new PersistentRunnerInteractionStore(runDir).createResponse(JSON.parse(encodedResponse));
        process.stdout.write(JSON.stringify({ kind: "accepted", source: receipt.decisionSource }));
      } catch (error) {
        if (error instanceof RunnerInteractionStoreError) {
          process.stdout.write(JSON.stringify({ kind: "rejected", code: error.code }));
        } else {
          throw error;
        }
      }
    `;
    const responses = [
      responseFixture(request, "allow=once/../✓", "child-alpha"),
      responseFixture(request, "reject once?", "child-beta")
    ];

    const results = await Promise.all(
      responses.map((response) =>
        execFileAsync(
          process.execPath,
          [
            "--import",
            "tsx",
            "--input-type=module",
            "-e",
            childSource,
            runDir,
            JSON.stringify(response)
          ],
          { cwd: join(dirname(fileURLToPath(import.meta.url)), "../../../..") }
        )
      )
    );
    const outcomes = results.map(({ stdout }) => JSON.parse(stdout));
    expect(outcomes.filter(({ kind }) => kind === "accepted")).toHaveLength(1);
    expect(outcomes.filter(({ code }) => code === "interaction_already_answered")).toHaveLength(1);
    await expect(store.readSnapshot("permission:1")).resolves.toMatchObject({ status: "answered" });
  });

  it.each([
    "response",
    "owner_result"
  ] as const)("uses one settlement CAS when %s wins across two controlled child processes", async (winnerKind) => {
    const runDir = await createRunDir();
    const store = new PersistentRunnerInteractionStore(runDir);
    const request = requestFixture();
    await store.createRequest(request);
    const modulePath = pathToFileURL(
      join(dirname(fileURLToPath(import.meta.url)), "../autoRun/runnerInteractionStore.ts")
    ).href;
    const childSource = `
        import { access, writeFile } from "node:fs/promises";
        import { PersistentRunnerInteractionStore, RunnerInteractionStoreError } from ${JSON.stringify(modulePath)};
        const [runDir, operation, role, gatePath, encodedValue] = process.argv.slice(-5);
        if (role === "loser") {
          while (true) {
            try { await access(gatePath); break; }
            catch { await new Promise((resolve) => setTimeout(resolve, 5)); }
          }
        }
        const store = new PersistentRunnerInteractionStore(runDir);
        try {
          if (operation === "response") await store.createResponse(JSON.parse(encodedValue));
          else await store.createOwnerResult(JSON.parse(encodedValue));
          if (role === "winner") await writeFile(gatePath, "claimed", { mode: 0o600 });
          process.stdout.write(JSON.stringify({ kind: "accepted", operation }));
        } catch (error) {
          if (error instanceof RunnerInteractionStoreError) {
            process.stdout.write(JSON.stringify({
              kind: "rejected",
              operation,
              code: error.code,
              winnerKind: error.details?.winnerKind
            }));
          } else throw error;
        }
      `;
    const gatePath = join(runDir, `${winnerKind}.claimed`);
    const response = responseFixture(request);
    const ownerResult = ownerResultFixture(request);
    const loserKind = winnerKind === "response" ? "owner_result" : "response";
    const invoke = (operation: "response" | "owner_result", role: "winner" | "loser") =>
      execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          childSource,
          runDir,
          operation,
          role,
          gatePath,
          JSON.stringify(operation === "response" ? response : ownerResult)
        ],
        { cwd: join(dirname(fileURLToPath(import.meta.url)), "../../../..") }
      );

    const [winner, loser] = await Promise.all([
      invoke(winnerKind, "winner"),
      invoke(loserKind, "loser")
    ]);
    expect(JSON.parse(winner.stdout)).toEqual({ kind: "accepted", operation: winnerKind });
    expect(JSON.parse(loser.stdout)).toEqual({
      kind: "rejected",
      operation: loserKind,
      code: "interaction_already_answered",
      winnerKind
    });
    await expect(store.readSnapshot(request.identity.requestId)).resolves.toMatchObject({
      status: winnerKind === "response" ? "answered" : "expired"
    });
    const loserCanonical = join(
      interactionDir(runDir),
      loserKind === "response" ? "response.json" : "owner-result.json"
    );
    await expect(readFile(loserCanonical, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
