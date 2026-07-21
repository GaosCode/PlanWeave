import { constants, type Dirent } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ZodType } from "zod";
import {
  type RunnerInteractionErrorCode,
  type RunnerInteractionRequest,
  type RunnerInteractionOwnerResult,
  type RunnerInteractionResponseReceipt,
  type RunnerInteractionSettlement,
  type RunnerInteractionSnapshot,
  type RunnerPermissionInteractionResponse,
  type RunnerPermissionOption,
  runnerInteractionRequestSchema,
  runnerInteractionOwnerResultSchema,
  runnerInteractionResponseReceiptSchema,
  runnerInteractionSettlementSchema,
  runnerInteractionSnapshotSchema,
  runnerInteractionIdentityMatches,
  runnerPermissionInteractionResponseSchema
} from "./runnerInteractionContract.js";
import { acpRequestIdSchema } from "./runnerContractSchemas.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export class RunnerInteractionStoreError extends Error {
  constructor(
    readonly code: RunnerInteractionErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, string | number | null>>
  ) {
    super(message);
    this.name = "RunnerInteractionStoreError";
  }
}

function errnoCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function contractError(subject: string): RunnerInteractionStoreError {
  return new RunnerInteractionStoreError(
    "interaction_contract_invalid",
    `${subject} does not match the runner interaction contract.`
  );
}

function parseContract<T>(schema: ZodType<T>, value: unknown, subject: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw contractError(subject);
  }
  return parsed.data;
}

function assertContained(root: string, candidate: string): void {
  const containedPath = relative(root, candidate);
  if (containedPath === "" || (!containedPath.startsWith("..") && !isAbsolute(containedPath))) {
    return;
  }
  throw new RunnerInteractionStoreError(
    "interaction_path_unsafe",
    "Runner interaction path must remain inside the canonical run directory."
  );
}

function encodedInteractionId(interactionId: string): string {
  const parsed = acpRequestIdSchema.safeParse(interactionId);
  if (!parsed.success) {
    throw new RunnerInteractionStoreError(
      "interaction_path_invalid",
      "Runner interaction id is not a valid safe identifier."
    );
  }
  return Buffer.from(parsed.data, "utf8").toString("base64url");
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new RunnerInteractionStoreError(
      "interaction_path_unsafe",
      "Runner interaction storage contains a non-directory or symbolic link."
    );
  }
  if (process.platform !== "win32" && (metadata.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    throw new RunnerInteractionStoreError(
      "interaction_path_unsafe",
      "Runner interaction directories must be accessible only by their owner."
    );
  }
}

async function createPrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: PRIVATE_DIRECTORY_MODE });
    if (process.platform !== "win32") {
      await chmod(path, PRIVATE_DIRECTORY_MODE);
    }
  } catch (error) {
    if (errnoCode(error) !== "EEXIST") {
      throw error;
    }
  }
  await assertPrivateDirectory(path);
}

async function assertPrivateCanonicalFile(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new RunnerInteractionStoreError(
      "interaction_path_unsafe",
      "Runner interaction canonical file must be a regular file, not a symbolic link."
    );
  }
  if ((metadata.mode & 0o777) !== PRIVATE_FILE_MODE) {
    throw new RunnerInteractionStoreError(
      "interaction_path_unsafe",
      "Runner interaction canonical file must be readable and writable only by its owner."
    );
  }
}

function withNoFollowFlag(baseFlags: number): number {
  return typeof constants.O_NOFOLLOW === "number" ? baseFlags | constants.O_NOFOLLOW : baseFlags;
}

/**
 * Open without following symlinks. Windows lacks O_NOFOLLOW; lstat already ran via
 * assertPrivateCanonicalFile for reads, and O_EXCL rejects pre-existing create paths.
 */
async function openPrivateFile(
  path: string,
  baseFlags: number,
  mode?: number
): Promise<Awaited<ReturnType<typeof open>>> {
  const flags = withNoFollowFlag(baseFlags);
  return mode === undefined ? open(path, flags) : open(path, flags, mode);
}

async function readPrivateJson<T>(path: string, schema: ZodType<T>, subject: string): Promise<T> {
  try {
    await assertPrivateCanonicalFile(path);
    const handle = await openPrivateFile(path, constants.O_RDONLY);
    try {
      const raw = await handle.readFile("utf8");
      let decoded: unknown;
      try {
        decoded = JSON.parse(raw);
      } catch {
        throw contractError(subject);
      }
      return parseContract(schema, decoded, subject);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof RunnerInteractionStoreError) throw error;
    if (errnoCode(error) === "ELOOP") {
      throw new RunnerInteractionStoreError(
        "interaction_path_unsafe",
        "Runner interaction canonical file must not be a symbolic link."
      );
    }
    throw error;
  }
}

async function publishPrivateJsonExclusive(
  path: string,
  value: unknown
): Promise<"created" | "exists"> {
  const directory = resolve(path, "..");
  const temporaryPath = join(
    directory,
    `.interaction.${process.pid}.${Date.now()}.${globalThis.crypto.randomUUID()}.tmp`
  );
  const handle = await openPrivateFile(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    PRIVATE_FILE_MODE
  );
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await link(temporaryPath, path);
    await chmod(path, PRIVATE_FILE_MODE);
    return "created";
  } catch (error) {
    if (errnoCode(error) === "EEXIST") return "exists";
    throw error;
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

function validateResponseForRequest(
  request: RunnerInteractionRequest,
  response: RunnerPermissionInteractionResponse
): RunnerPermissionOption | null {
  if (!runnerInteractionIdentityMatches(request.identity, response.identity)) {
    throw new RunnerInteractionStoreError(
      "interaction_identity_mismatch",
      "Runner interaction response identity does not exactly match its request."
    );
  }
  if (response.decision.kind === "cancel") {
    return null;
  }
  const selectedOptionId = response.decision.optionId;
  const selectedOption =
    request.options.find(({ optionId }) => optionId === selectedOptionId) ?? null;
  if (selectedOption === null) {
    throw new RunnerInteractionStoreError(
      "interaction_option_not_advertised",
      "Runner interaction response selected an option that the Agent did not advertise."
    );
  }
  return selectedOption;
}

function validateSettlementForRequest(
  request: RunnerInteractionRequest,
  settlement: RunnerInteractionSettlement
): void {
  if (settlement.kind === "response") {
    validateResponseForRequest(request, settlement.response);
    return;
  }
  if (!runnerInteractionIdentityMatches(request.identity, settlement.ownerResult.identity)) {
    throw new RunnerInteractionStoreError(
      "interaction_identity_mismatch",
      "Runner interaction owner result identity does not exactly match its request."
    );
  }
}

export interface RunnerInteractionSettlementResult {
  accepted: boolean;
  winner: RunnerInteractionSettlement;
}

export class PersistentRunnerInteractionStore {
  constructor(readonly runDir: string) {}

  async createRequest(requestInput: RunnerInteractionRequest): Promise<RunnerInteractionSnapshot> {
    const request = parseContract(
      runnerInteractionRequestSchema,
      requestInput,
      "Runner interaction request"
    );
    const interactionDir = await this.ensureInteractionDirectory(request.identity.requestId);
    const requestPath = join(interactionDir, "request.json");
    const publication = await publishPrivateJsonExclusive(requestPath, request);
    if (publication === "exists") {
      const existing = await readPrivateJson(
        requestPath,
        runnerInteractionRequestSchema,
        "Runner interaction request"
      );
      if (canonicalJson(existing) !== canonicalJson(request)) {
        throw new RunnerInteractionStoreError(
          "interaction_request_conflict",
          "An immutable interaction request already exists with different content."
        );
      }
    }
    return this.readSnapshot(request.identity.requestId);
  }

  async createResponse(
    responseInput: RunnerPermissionInteractionResponse
  ): Promise<RunnerInteractionResponseReceipt> {
    const response = parseContract(
      runnerPermissionInteractionResponseSchema,
      responseInput,
      "Runner interaction response"
    );
    const interactionDir = await this.resolveExistingInteractionDirectory(
      response.identity.requestId
    );
    const request = await readPrivateJson(
      join(interactionDir, "request.json"),
      runnerInteractionRequestSchema,
      "Runner interaction request"
    );
    const selectedOption = validateResponseForRequest(request, response);
    const settlement = await this.settle(interactionDir, request, {
      version: "planweave.runner-interaction-settlement/v1",
      kind: "response",
      response
    });
    if (!settlement.accepted || settlement.winner.kind !== "response") {
      throw this.alreadySettledError(settlement.winner);
    }

    return parseContract(
      runnerInteractionResponseReceiptSchema,
      {
        version: "planweave.runner-interaction-response-receipt/v1",
        identity: response.identity,
        acceptedAt: response.respondedAt,
        decision: response.decision,
        selectedOption,
        decisionSource: response.decisionSource
      },
      "Runner interaction response receipt"
    );
  }

  async createOwnerResult(
    resultInput: RunnerInteractionOwnerResult
  ): Promise<RunnerInteractionOwnerResult> {
    const result = parseContract(
      runnerInteractionOwnerResultSchema,
      resultInput,
      "Runner interaction owner result"
    );
    const interactionDir = await this.resolveExistingInteractionDirectory(
      result.identity.requestId
    );
    const request = await readPrivateJson(
      join(interactionDir, "request.json"),
      runnerInteractionRequestSchema,
      "Runner interaction request"
    );
    validateSettlementForRequest(request, {
      version: "planweave.runner-interaction-settlement/v1",
      kind: "owner_result",
      ownerResult: result
    });
    const settlement = await this.settleOwnerResultForRequest(interactionDir, request, result);
    if (
      settlement.winner.kind === "owner_result" &&
      canonicalJson(settlement.winner.ownerResult) === canonicalJson(result)
    ) {
      return settlement.winner.ownerResult;
    }
    throw this.alreadySettledError(settlement.winner);
  }

  async settleOwnerResult(
    resultInput: RunnerInteractionOwnerResult
  ): Promise<RunnerInteractionSettlementResult> {
    const result = parseContract(
      runnerInteractionOwnerResultSchema,
      resultInput,
      "Runner interaction owner result"
    );
    const interactionDir = await this.resolveExistingInteractionDirectory(
      result.identity.requestId
    );
    const request = await readPrivateJson(
      join(interactionDir, "request.json"),
      runnerInteractionRequestSchema,
      "Runner interaction request"
    );
    validateSettlementForRequest(request, {
      version: "planweave.runner-interaction-settlement/v1",
      kind: "owner_result",
      ownerResult: result
    });
    return this.settleOwnerResultForRequest(interactionDir, request, result);
  }

  async readSnapshot(interactionId: string): Promise<RunnerInteractionSnapshot> {
    const interactionDir = await this.resolveExistingInteractionDirectory(interactionId);
    const request = await readPrivateJson(
      join(interactionDir, "request.json"),
      runnerInteractionRequestSchema,
      "Runner interaction request"
    );
    if (request.identity.requestId !== interactionId) {
      throw contractError("Runner interaction directory identity");
    }
    const settlement = await this.readSettlement(interactionDir, request);
    const response = settlement?.kind === "response" ? settlement.response : null;
    const ownerResult = settlement?.kind === "owner_result" ? settlement.ownerResult : null;
    return parseContract(
      runnerInteractionSnapshotSchema,
      {
        version: "planweave.runner-interaction-snapshot/v1",
        interactionId: request.identity.requestId,
        status: response ? "answered" : ownerResult ? "expired" : "pending",
        request,
        response,
        ownerResult
      },
      "Runner interaction snapshot"
    );
  }

  async listSnapshots(): Promise<RunnerInteractionSnapshot[]> {
    const runRoot = await this.canonicalRunRoot();
    const interactionsDir = join(runRoot, "interactions");
    let entries: Dirent[];
    try {
      await assertPrivateDirectory(interactionsDir);
      entries = await readdir(interactionsDir, { withFileTypes: true });
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return [];
      throw error;
    }

    const snapshots: RunnerInteractionSnapshot[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isSymbolicLink()) {
        throw new RunnerInteractionStoreError(
          "interaction_path_unsafe",
          "Runner interactions directory contains a symbolic link."
        );
      }
      if (!entry.isDirectory()) continue;
      const interactionDir = join(interactionsDir, entry.name);
      await assertPrivateDirectory(interactionDir);
      let request: RunnerInteractionRequest;
      try {
        request = await readPrivateJson(
          join(interactionDir, "request.json"),
          runnerInteractionRequestSchema,
          "Runner interaction request"
        );
      } catch (error) {
        if (errnoCode(error) === "ENOENT") continue;
        throw error;
      }
      if (encodedInteractionId(request.identity.requestId) !== entry.name) {
        throw contractError("Runner interaction directory identity");
      }
      snapshots.push(await this.readSnapshot(request.identity.requestId));
    }
    return snapshots;
  }

  private async settleOwnerResultForRequest(
    interactionDir: string,
    request: RunnerInteractionRequest,
    result: RunnerInteractionOwnerResult
  ): Promise<RunnerInteractionSettlementResult> {
    return this.settle(interactionDir, request, {
      version: "planweave.runner-interaction-settlement/v1",
      kind: "owner_result",
      ownerResult: result
    });
  }

  private async settle(
    interactionDir: string,
    request: RunnerInteractionRequest,
    proposed: RunnerInteractionSettlement
  ): Promise<RunnerInteractionSettlementResult> {
    const settlementPath = join(interactionDir, "settlement.json");
    let winner = await this.readOptionalSettlement(interactionDir);
    let accepted = false;
    if (winner === null) {
      const legacy = await this.readLegacySettlement(interactionDir, request);
      const candidate = legacy ?? proposed;
      const publication = await publishPrivateJsonExclusive(settlementPath, candidate);
      if (publication === "created") {
        winner = candidate;
        accepted = legacy === null;
      } else {
        winner = await readPrivateJson(
          settlementPath,
          runnerInteractionSettlementSchema,
          "Runner interaction settlement"
        );
      }
    }
    validateSettlementForRequest(request, winner);
    await this.materializeSettlement(interactionDir, request, winner);
    return { accepted, winner };
  }

  private async readSettlement(
    interactionDir: string,
    request: RunnerInteractionRequest
  ): Promise<RunnerInteractionSettlement | null> {
    const settlement =
      (await this.readOptionalSettlement(interactionDir)) ??
      (await this.readLegacySettlement(interactionDir, request));
    if (settlement === null) return null;
    validateSettlementForRequest(request, settlement);
    await this.validateMaterializedSettlement(interactionDir, request, settlement);
    return settlement;
  }

  private async readLegacySettlement(
    interactionDir: string,
    request: RunnerInteractionRequest
  ): Promise<RunnerInteractionSettlement | null> {
    const [response, ownerResult] = await Promise.all([
      this.readOptionalResponse(interactionDir),
      this.readOptionalOwnerResult(interactionDir)
    ]);
    if (response && ownerResult) {
      throw contractError("Runner interaction settlement");
    }
    if (response) {
      validateResponseForRequest(request, response);
      return {
        version: "planweave.runner-interaction-settlement/v1",
        kind: "response",
        response
      };
    }
    if (ownerResult) {
      validateSettlementForRequest(request, {
        version: "planweave.runner-interaction-settlement/v1",
        kind: "owner_result",
        ownerResult
      });
      return {
        version: "planweave.runner-interaction-settlement/v1",
        kind: "owner_result",
        ownerResult
      };
    }
    return null;
  }

  private async materializeSettlement(
    interactionDir: string,
    request: RunnerInteractionRequest,
    settlement: RunnerInteractionSettlement
  ): Promise<void> {
    const targetPath = join(
      interactionDir,
      settlement.kind === "response" ? "response.json" : "owner-result.json"
    );
    const target = settlement.kind === "response" ? settlement.response : settlement.ownerResult;
    await publishPrivateJsonExclusive(targetPath, target);
    await this.validateMaterializedSettlement(interactionDir, request, settlement, true);
  }

  private async validateMaterializedSettlement(
    interactionDir: string,
    request: RunnerInteractionRequest,
    settlement: RunnerInteractionSettlement,
    requireTarget = false
  ): Promise<void> {
    const [response, ownerResult] = await Promise.all([
      this.readOptionalResponse(interactionDir),
      this.readOptionalOwnerResult(interactionDir)
    ]);
    if (settlement.kind === "response") {
      if (ownerResult) throw contractError("Runner interaction settlement");
      if (response) {
        validateResponseForRequest(request, response);
        if (canonicalJson(response) !== canonicalJson(settlement.response)) {
          throw contractError("Runner interaction response settlement");
        }
      } else if (requireTarget) {
        throw contractError("Runner interaction response settlement");
      }
      return;
    }
    if (response) throw contractError("Runner interaction settlement");
    if (ownerResult) {
      validateSettlementForRequest(request, settlement);
      if (canonicalJson(ownerResult) !== canonicalJson(settlement.ownerResult)) {
        throw contractError("Runner interaction owner result settlement");
      }
    } else if (requireTarget) {
      throw contractError("Runner interaction owner result settlement");
    }
  }

  private alreadySettledError(
    settlement: RunnerInteractionSettlement
  ): RunnerInteractionStoreError {
    if (settlement.kind === "response") {
      return new RunnerInteractionStoreError(
        "interaction_already_answered",
        "Runner interaction already has an immutable response.",
        {
          respondedAt: settlement.response.respondedAt,
          decisionSource: settlement.response.decisionSource,
          winnerKind: "response"
        }
      );
    }
    return new RunnerInteractionStoreError(
      "interaction_already_answered",
      "Runner interaction was already expired by its owner.",
      {
        respondedAt: settlement.ownerResult.recordedAt,
        decisionSource: "run-owner",
        winnerKind: "owner_result"
      }
    );
  }

  private async canonicalRunRoot(): Promise<string> {
    try {
      return await realpath(this.runDir);
    } catch (error) {
      if (errnoCode(error) === "ENOENT" || errnoCode(error) === "ENOTDIR") {
        throw new RunnerInteractionStoreError(
          "interaction_path_invalid",
          "Runner interaction store requires an existing run directory."
        );
      }
      throw error;
    }
  }

  private async ensureInteractionDirectory(interactionId: string): Promise<string> {
    const runRoot = await this.canonicalRunRoot();
    const interactionsDir = join(runRoot, "interactions");
    assertContained(runRoot, interactionsDir);
    await createPrivateDirectory(interactionsDir);
    const realInteractionsDir = await realpath(interactionsDir);
    assertContained(runRoot, realInteractionsDir);

    const interactionDir = join(realInteractionsDir, encodedInteractionId(interactionId));
    assertContained(realInteractionsDir, interactionDir);
    await createPrivateDirectory(interactionDir);
    const realInteractionDir = await realpath(interactionDir);
    assertContained(realInteractionsDir, realInteractionDir);
    return realInteractionDir;
  }

  private async resolveExistingInteractionDirectory(interactionId: string): Promise<string> {
    const runRoot = await this.canonicalRunRoot();
    const interactionsDir = join(runRoot, "interactions");
    const interactionDir = join(interactionsDir, encodedInteractionId(interactionId));
    assertContained(runRoot, interactionDir);
    try {
      await Promise.all([
        assertPrivateDirectory(interactionsDir),
        assertPrivateDirectory(interactionDir)
      ]);
      const [realInteractionsDir, realInteractionDir] = await Promise.all([
        realpath(interactionsDir),
        realpath(interactionDir)
      ]);
      assertContained(runRoot, realInteractionsDir);
      assertContained(realInteractionsDir, realInteractionDir);
      return realInteractionDir;
    } catch (error) {
      if (error instanceof RunnerInteractionStoreError) throw error;
      if (errnoCode(error) === "ENOENT" || errnoCode(error) === "ENOTDIR") {
        throw new RunnerInteractionStoreError(
          "interaction_not_found",
          "Runner interaction does not exist."
        );
      }
      throw error;
    }
  }

  private async readOptionalResponse(
    interactionDir: string
  ): Promise<RunnerPermissionInteractionResponse | null> {
    const responsePath = join(interactionDir, "response.json");
    try {
      return await readPrivateJson(
        responsePath,
        runnerPermissionInteractionResponseSchema,
        "Runner interaction response"
      );
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return null;
      throw error;
    }
  }

  private async readOptionalSettlement(
    interactionDir: string
  ): Promise<RunnerInteractionSettlement | null> {
    try {
      return await readPrivateJson(
        join(interactionDir, "settlement.json"),
        runnerInteractionSettlementSchema,
        "Runner interaction settlement"
      );
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return null;
      throw error;
    }
  }

  private async readOptionalOwnerResult(
    interactionDir: string
  ): Promise<RunnerInteractionOwnerResult | null> {
    try {
      return await readPrivateJson(
        join(interactionDir, "owner-result.json"),
        runnerInteractionOwnerResultSchema,
        "Runner interaction owner result"
      );
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return null;
      throw error;
    }
  }
}
