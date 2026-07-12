/**
 * A6 Coordinator Agent acceptance tests.
 *
 * Acceptance criteria:
 *   1. The Agent cannot approve a proposal
 *   2. Artifact output with missing/foreign citations is rejected
 *   3. Cancellation and restart leave a recoverable run state
 *   4. Fake provider produces deterministic outputs for tests
 *   5. Citation validation rejects invalid message/attachment references
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyMigrations } from "../../migrations.js"
import { applyIdentityMigrations } from "../../identity/migrations.js"
import { applyPlanningMigrations } from "../../planning/migrations.js"
import { applyProposalsMigrations } from "../../proposals/migrations.js"
import { applyAttachmentsMigrations } from "../../attachments/migrations.js"
import { applyAgentsMigrations } from "../migrations.js"
import type { SqliteDatabase } from "../../sqlite.js"
import { openServerDatabase } from "../../sqlite.js"
import { createAgentRepository, createAgentServices, createFakeAgentProvider, AgentError, assertAgentCannotApprove, type AgentServices, type AgentProviderOutput } from "../index.js"
import type { ArtifactCitation } from "../index.js"

type AgentTestHarness = {
  dataDirectory: string
  database: SqliteDatabase
  services: AgentServices
  seedProject(projectId: string, name: string): void
  seedRoom(input: { id: string; projectId: string; name: string }): void
  seedUser(input: { userId: string; projectId: string; role: string }): void
  seedMessage(input: { id: string; roomId: string; authorUserId: string; body: string }): void
  seedAttachment(input: { id: string; projectId: string; uploaderUserId: string; originalName: string }): void
  close(): void
}

async function createAgentHarness(): Promise<AgentTestHarness> {
  const dataDirectory = await mkdtemp(join(tmpdir(), "planweave-a6-"))
  const databasePath = join(dataDirectory, "server.sqlite")
  const database = await openServerDatabase(databasePath, 5000)
  applyMigrations(database)
  applyIdentityMigrations(database)
  applyPlanningMigrations(database)
  applyProposalsMigrations(database)
  applyAttachmentsMigrations(database)
  applyAgentsMigrations(database)

  const repository = createAgentRepository({ database })
  const provider = createFakeAgentProvider()
  const services = createAgentServices({ repository, provider })

  const seedProject = (projectId: string, name: string) => {
    database.prepare("INSERT INTO projects(id,version,name,created_at) VALUES (?,?,?,?)")
      .run(projectId, 1, name, new Date().toISOString())
  }

  const seedRoom = (input: { id: string; projectId: string; name: string }) => {
    database.prepare("INSERT INTO rooms(id,project_id,name,created_at,archived_at) VALUES (?,?,?,?,?)")
      .run(input.id, input.projectId, input.name, new Date().toISOString(), null)
  }

  const seedUser = (input: { userId: string; projectId: string; role: string }) => {
    database.prepare("INSERT INTO users(id,display_name,created_at) VALUES (?,?,?)")
      .run(input.userId, input.userId, new Date().toISOString())
    database.prepare("INSERT INTO memberships(project_id,user_id,role,created_at) VALUES (?,?,?,?)")
      .run(input.projectId, input.userId, input.role, new Date().toISOString())
  }

  const seedMessage = (input: { id: string; roomId: string; authorUserId: string; body: string }) => {
    database.prepare("INSERT INTO messages(id,room_id,author_user_id,body,kind,created_at,supersedes_message_id) VALUES (?,?,?,?,?,?,?)")
      .run(input.id, input.roomId, input.authorUserId, input.body, "text", new Date().toISOString(), null)
  }

  const seedAttachment = (input: { id: string; projectId: string; uploaderUserId: string; originalName: string }) => {
    database.prepare("INSERT INTO attachments(id,project_id,uploader_user_id,declared_size,declared_digest,actual_size,actual_digest,status,original_name,media_type,staged_path,created_at,promoted_at,supersedes_attachment_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(input.id, input.projectId, input.uploaderUserId, 1024, "sha256:abc", null, null, "ready", input.originalName, "text/plain", "/tmp/test", new Date().toISOString(), null, null)
  }

  return {
    dataDirectory,
    database,
    services,
    seedProject,
    seedRoom,
    seedUser,
    seedMessage,
    seedAttachment,
    close: () => database.close()
  }
}

async function cleanupAgentHarness(harness: AgentTestHarness): Promise<void> {
  harness.close()
  await rm(harness.dataDirectory, { recursive: true, force: true })
}

describe("A6 coordinator agent", () => {
  let harness: AgentTestHarness

  beforeEach(async () => {
    harness = await createAgentHarness()
  })

  afterEach(async () => {
    await cleanupAgentHarness(harness)
  })

  /* ------------------------------------------------------------------ *
   * AC 1: The Agent cannot approve a proposal                           *
   * ------------------------------------------------------------------ */

  it("throws state_conflict when assertAgentCannotApprove is called (Agent cannot approve)", () => {
    expect(() => assertAgentCannotApprove()).toThrow(AgentError)
    expect(() => assertAgentCannotApprove()).toThrow("The Agent identity cannot approve proposals.")
  })

  /* ------------------------------------------------------------------ *
   * AC 2: Artifact output with missing/foreign citations is rejected    *
   * ------------------------------------------------------------------ */

  it("rejects artifact output containing citations to non-existent messages", async () => {
    harness.seedProject("proj-cite", "Citation Project")
    harness.seedUser({ userId: "user-a", projectId: "proj-cite", role: "contributor" })
    harness.seedRoom({ id: "room-cite", projectId: "proj-cite", name: "Citation Room" })

    const badOutput: AgentProviderOutput = {
      done: true,
      artifacts: [
        {
          kind: "brief",
          title: "Test brief",
          body: "Summary with bad citation.",
          citations: [{ kind: "message", id: "msg-nonexistent" } as ArtifactCitation]
        }
      ]
    }
    const provider = createFakeAgentProvider({ outputs: [badOutput] })
    const repo = createAgentRepository({ database: harness.database })
    const services = createAgentServices({ repository: repo, provider })

    let caught: AgentError | undefined
    try {
      await services.startRun({
        deviceId: "dev-1",
        idempotencyKey: "start-run-bad-citation---aaaa",
        projectId: "proj-cite",
        roomId: "room-cite",
        providerType: "fake",
        budget: { maxTokens: 1000, maxDurationMs: 60000, maxRetries: 0 },
        actorId: "user-a"
      })
    } catch (error) {
      caught = error as AgentError
    }
    expect(caught).toBeInstanceOf(AgentError)
    expect(caught?.code).toBe("citation_invalid")
    expect(caught?.details.invalidCitations).toEqual([{ kind: "message", id: "msg-nonexistent" }])
  })

  it("rejects artifact output containing citations to non-existent attachments", async () => {
    harness.seedProject("proj-attcite", "Attachment Citation Project")
    harness.seedUser({ userId: "user-a", projectId: "proj-attcite", role: "contributor" })
    harness.seedRoom({ id: "room-attcite", projectId: "proj-attcite", name: "Attachment Room" })

    const badOutput: AgentProviderOutput = {
      done: true,
      artifacts: [
        {
          kind: "requirements",
          title: "Requirements",
          body: "Requirements with bad attachment citation.",
          citations: [{ kind: "attachment", id: "att-nonexistent" } as ArtifactCitation]
        }
      ]
    }
    const provider = createFakeAgentProvider({ outputs: [badOutput] })
    const repo = createAgentRepository({ database: harness.database })
    const services = createAgentServices({ repository: repo, provider })

    let caught: AgentError | undefined
    try {
      await services.startRun({
        deviceId: "dev-1",
        idempotencyKey: "start-run-bad-att-cite---aa",
        projectId: "proj-attcite",
        roomId: "room-attcite",
        providerType: "fake",
        budget: { maxTokens: 1000, maxDurationMs: 60000, maxRetries: 0 },
        actorId: "user-a"
      })
    } catch (error) {
      caught = error as AgentError
    }
    expect(caught).toBeInstanceOf(AgentError)
    expect(caught?.code).toBe("citation_invalid")
  })

  it("accepts artifact output with valid citations to existing messages and attachments", async () => {
    harness.seedProject("proj-validcite", "Valid Citation Project")
    harness.seedUser({ userId: "user-a", projectId: "proj-validcite", role: "contributor" })
    harness.seedRoom({ id: "room-validcite", projectId: "proj-validcite", name: "Valid Room" })
    harness.seedMessage({ id: "msg-1", roomId: "room-validcite", authorUserId: "user-a", body: "Hello world" })
    harness.seedAttachment({ id: "att-1", projectId: "proj-validcite", uploaderUserId: "user-a", originalName: "readme.md" })

    const validOutput: AgentProviderOutput = {
      done: true,
      artifacts: [
        {
          kind: "brief",
          title: "Brief with valid citations",
          body: "Based on the message and attachment.",
          citations: [
            { kind: "message", id: "msg-1" } as ArtifactCitation,
            { kind: "attachment", id: "att-1" } as ArtifactCitation
          ]
        }
      ]
    }
    const provider = createFakeAgentProvider({ outputs: [validOutput] })
    const repo = createAgentRepository({ database: harness.database })
    const services = createAgentServices({ repository: repo, provider })

    const result = await services.startRun({
      deviceId: "dev-1",
      idempotencyKey: "start-run-valid-cite-----aa",
      projectId: "proj-validcite",
      roomId: "room-validcite",
      providerType: "fake",
      budget: { maxTokens: 1000, maxDurationMs: 60000, maxRetries: 0 },
      actorId: "user-a"
    })

    expect(result.replayed).toBe(false)
    expect(result.value.run.status).toBe("completed")
    expect(result.value.artifacts).toHaveLength(1)
    expect(result.value.artifacts[0].citations).toEqual([
      { kind: "message", id: "msg-1" },
      { kind: "attachment", id: "att-1" }
    ])
  })

  /* ------------------------------------------------------------------ *
   * AC 3: Cancellation and restart leave a recoverable run state       *
   * ------------------------------------------------------------------ */

  it("cancels a running agent run and transitions the state to cancelled", async () => {
    harness.seedProject("proj-cancel", "Cancel Project")
    harness.seedUser({ userId: "user-a", projectId: "proj-cancel", role: "contributor" })
    harness.seedRoom({ id: "room-cancel", projectId: "proj-cancel", name: "Cancel Room" })

    const output: AgentProviderOutput = {
      done: false,
      artifacts: [
        {
          kind: "brief",
          title: "First checkpoint brief",
          body: "Partial analysis.",
          citations: []
        }
      ]
    }
    const provider = createFakeAgentProvider({ outputs: [output] })
    const repo = createAgentRepository({ database: harness.database })
    const services = createAgentServices({ repository: repo, provider })

    const started = await services.startRun({
      deviceId: "dev-1",
      idempotencyKey: "start-run-cancel----------aa",
      projectId: "proj-cancel",
      roomId: "room-cancel",
      providerType: "fake",
      budget: { maxTokens: 1000, maxDurationMs: 60000, maxRetries: 0 },
      actorId: "user-a"
    })

    expect(started.value.run.status).toBe("running")

    const cancelled = services.cancelRun({
      deviceId: "dev-1",
      idempotencyKey: "cancel-run-cancel---------aa",
      runId: started.value.run.id,
      actorId: "user-a"
    })

    expect(cancelled.replayed).toBe(false)
    expect(cancelled.value.run.status).toBe("cancelled")
    expect(cancelled.value.run.cancelledAt).toBeTruthy()

    const run = services.getRun(started.value.run.id)
    expect(run?.status).toBe("cancelled")
  })

  it("restart after cancellation leaves prior artifacts and checkpoint intact", async () => {
    harness.seedProject("proj-restart", "Restart Project")
    harness.seedUser({ userId: "user-a", projectId: "proj-restart", role: "contributor" })
    harness.seedRoom({ id: "room-restart", projectId: "proj-restart", name: "Restart Room" })

    const output1: AgentProviderOutput = {
      done: false,
      artifacts: [
        {
          kind: "brief",
          title: "Brief v1",
          body: "Initial analysis.",
          citations: []
        }
      ]
    }
    const provider1 = createFakeAgentProvider({ outputs: [output1] })
    const repo1 = createAgentRepository({ database: harness.database })
    const services1 = createAgentServices({ repository: repo1, provider: provider1 })

    const started1 = await services1.startRun({
      deviceId: "dev-1",
      idempotencyKey: "start-run-1-restart--------aa",
      projectId: "proj-restart",
      roomId: "room-restart",
      providerType: "fake",
      budget: { maxTokens: 1000, maxDurationMs: 60000, maxRetries: 0 },
      actorId: "user-a"
    })
    expect(started1.value.run.status).toBe("running")
    expect(started1.value.artifacts).toHaveLength(1)

    services1.cancelRun({
      deviceId: "dev-1",
      idempotencyKey: "cancel-run-1-restart------aa",
      runId: started1.value.run.id,
      actorId: "user-a"
    })

    const output2: AgentProviderOutput = {
      done: true,
      artifacts: [
        {
          kind: "requirements",
          title: "Requirements v1",
          body: "Follow-up analysis.",
          citations: []
        }
      ]
    }
    const provider2 = createFakeAgentProvider({ outputs: [output2] })
    const repo2 = createAgentRepository({ database: harness.database })
    const services2 = createAgentServices({ repository: repo2, provider: provider2 })

    const started2 = await services2.startRun({
      deviceId: "dev-1",
      idempotencyKey: "start-run-2-restart--------aa",
      projectId: "proj-restart",
      roomId: "room-restart",
      providerType: "fake",
      budget: { maxTokens: 1000, maxDurationMs: 60000, maxRetries: 0 },
      actorId: "user-a"
    })

    expect(started2.replayed).toBe(false)
    expect(started2.value.run.status).toBe("completed")
    expect(started2.value.artifacts).toHaveLength(1)

    const artifacts1 = services1.getArtifactsForRun(started1.value.run.id)
    expect(artifacts1).toHaveLength(1)
    expect(artifacts1[0].kind).toBe("brief")

    const priorRun = services1.getRun(started1.value.run.id)
    expect(priorRun?.status).toBe("cancelled")
  })

  it("cancellation event and audit log is emitted", async () => {
    harness.seedProject("proj-audit", "Audit Project")
    harness.seedUser({ userId: "user-a", projectId: "proj-audit", role: "contributor" })
    harness.seedRoom({ id: "room-audit", projectId: "proj-audit", name: "Audit Room" })

    const output: AgentProviderOutput = {
      done: false,
      artifacts: [{ kind: "brief", title: "Brief", body: "Body", citations: [] }]
    }
    const provider = createFakeAgentProvider({ outputs: [output] })
    const repo = createAgentRepository({ database: harness.database })
    const services = createAgentServices({ repository: repo, provider })

    const started = await services.startRun({
      deviceId: "dev-1",
      idempotencyKey: "start-run-audit-----------aa",
      projectId: "proj-audit",
      roomId: "room-audit",
      providerType: "fake",
      budget: { maxTokens: 1000, maxDurationMs: 60000, maxRetries: 0 },
      actorId: "user-a"
    })

    const eventCountBefore = countEvents(harness)
    const auditCountBefore = countAuditRows(harness)

    services.cancelRun({
      deviceId: "dev-1",
      idempotencyKey: "cancel-run-audit----------aa",
      runId: started.value.run.id,
      actorId: "user-a"
    })

    expect(countEvents(harness)).toBeGreaterThan(eventCountBefore)
    expect(countAuditRows(harness)).toBeGreaterThan(auditCountBefore)
  })

  /* ------------------------------------------------------------------ *
   * AC 4: Fake provider produces deterministic outputs                 *
   * ------------------------------------------------------------------ */

  it("fake provider returns predefined deterministic outputs", async () => {
    const provider = createFakeAgentProvider()
    const context = {
      room: { id: "room-1", projectId: "proj-1" },
      messages: [],
      attachments: [],
      existingArtifacts: [],
      budget: { maxTokens: 1000, maxDurationMs: 60000, maxRetries: 0 }
    }

    const output1 = await provider.run(context)
    expect(output1.done).toBe(true)
    expect(output1.artifacts).toHaveLength(3)
    expect(output1.artifacts[0].kind).toBe("brief")
    expect(output1.artifacts[1].kind).toBe("requirements")
    expect(output1.artifacts[2].kind).toBe("constraints")

    const output2 = await provider.run(context)
    expect(output2).toEqual(output1)
  })

  it("fake provider returns custom predefined outputs", async () => {
    const customOutput: AgentProviderOutput = {
      done: true,
      artifacts: [
        { kind: "adr_candidate", title: "ADR 1", body: "Use SQLite", citations: [] },
        { kind: "open_question", title: "Q1", body: "What about scaling?", citations: [] }
      ]
    }
    const provider = createFakeAgentProvider({ outputs: [customOutput] })

    const output = await provider.run({
      room: { id: "room-1", projectId: "proj-1" },
      messages: [],
      attachments: [],
      existingArtifacts: [],
      budget: { maxTokens: 1000, maxDurationMs: 60000, maxRetries: 0 }
    })

    expect(output.artifacts).toHaveLength(2)
    expect(output.artifacts[0].kind).toBe("adr_candidate")
    expect(output.artifacts[1].kind).toBe("open_question")
  })

  it("fake provider throws on failure flag", async () => {
    const provider = createFakeAgentProvider({ shouldFail: new Error("Provider error") })
    await expect(provider.run({
      room: { id: "room-1", projectId: "proj-1" },
      messages: [],
      attachments: [],
      existingArtifacts: [],
      budget: { maxTokens: 1000, maxDurationMs: 60000, maxRetries: 0 }
    })).rejects.toThrow("Provider error")
  })

  /* ------------------------------------------------------------------ *
   * Idempotency tests                                                   *
   * ------------------------------------------------------------------ */

  it("replays a startRun command with the same idempotency key", async () => {
    harness.seedProject("proj-idem", "Idempotency Project")
    harness.seedUser({ userId: "user-a", projectId: "proj-idem", role: "contributor" })
    harness.seedRoom({ id: "room-idem", projectId: "proj-idem", name: "Idem Room" })

    const output: AgentProviderOutput = {
      done: true,
      artifacts: [{ kind: "brief", title: "Brief", body: "Body", citations: [] }]
    }
    const provider = createFakeAgentProvider({ outputs: [output] })
    const repo = createAgentRepository({ database: harness.database })
    const services = createAgentServices({ repository: repo, provider })

    const key = "start-run-idem-aaaaaaaaaa"
    const first = await services.startRun({
      deviceId: "dev-1",
      idempotencyKey: key,
      projectId: "proj-idem",
      roomId: "room-idem",
      providerType: "fake",
      budget: { maxTokens: 1000, maxDurationMs: 60000, maxRetries: 0 },
      actorId: "user-a"
    })
    expect(first.replayed).toBe(false)

    const second = await services.startRun({
      deviceId: "dev-1",
      idempotencyKey: key,
      projectId: "proj-idem",
      roomId: "room-idem",
      providerType: "fake",
      budget: { maxTokens: 1000, maxDurationMs: 60000, maxRetries: 0 },
      actorId: "user-a"
    })
    expect(second.replayed).toBe(true)
    expect(second.value).toEqual(first.value)
  })

  /* ------------------------------------------------------------------ *
   * Edge case tests                                                     *
   * ------------------------------------------------------------------ */

  it("rejects a cancel on an already-cancelled run (no-op success)", async () => {
    harness.seedProject("proj-double", "Double Cancel")
    harness.seedUser({ userId: "user-a", projectId: "proj-double", role: "contributor" })
    harness.seedRoom({ id: "room-double", projectId: "proj-double", name: "Double Room" })

    const output: AgentProviderOutput = {
      done: false,
      artifacts: [{ kind: "brief", title: "Brief", body: "Body", citations: [] }]
    }
    const provider = createFakeAgentProvider({ outputs: [output] })
    const repo = createAgentRepository({ database: harness.database })
    const services = createAgentServices({ repository: repo, provider })

    const started = await services.startRun({
      deviceId: "dev-1",
      idempotencyKey: "start-run-doublec--------aa",
      projectId: "proj-double",
      roomId: "room-double",
      providerType: "fake",
      budget: { maxTokens: 1000, maxDurationMs: 60000, maxRetries: 0 },
      actorId: "user-a"
    })

    services.cancelRun({
      deviceId: "dev-1",
      idempotencyKey: "cancel-1-doublec--------aa",
      runId: started.value.run.id,
      actorId: "user-a"
    })

    const secondCancel = services.cancelRun({
      deviceId: "dev-1",
      idempotencyKey: "cancel-2-doublec--------aa",
      runId: started.value.run.id,
      actorId: "user-a"
    })
    expect(secondCancel.value.run.status).toBe("cancelled")
  })

  it("rejects a start run with invalid budget values", async () => {
    harness.seedProject("proj-budget", "Budget Project")
    harness.seedUser({ userId: "user-a", projectId: "proj-budget", role: "contributor" })
    harness.seedRoom({ id: "room-budget", projectId: "proj-budget", name: "Budget Room" })

    const provider = createFakeAgentProvider()
    const repo = createAgentRepository({ database: harness.database })
    const services = createAgentServices({ repository: repo, provider })

    await expect(services.startRun({
      deviceId: "dev-1",
      idempotencyKey: "start-run-budget-0--------aa",
      projectId: "proj-budget",
      roomId: "room-budget",
      providerType: "fake",
      budget: { maxTokens: 0, maxDurationMs: 60000, maxRetries: 0 },
      actorId: "user-a"
    })).rejects.toThrow(AgentError)

    await expect(services.startRun({
      deviceId: "dev-1",
      idempotencyKey: "start-run-budget-neg------aa",
      projectId: "proj-budget",
      roomId: "room-budget",
      providerType: "fake",
      budget: { maxTokens: 1000, maxDurationMs: 60000, maxRetries: -1 },
      actorId: "user-a"
    })).rejects.toThrow(AgentError)
  })

  it("rejects a start run to a non-existent room", async () => {
    harness.seedProject("proj-noroom", "No Room Project")
    harness.seedUser({ userId: "user-a", projectId: "proj-noroom", role: "contributor" })

    const provider = createFakeAgentProvider()
    const repo = createAgentRepository({ database: harness.database })
    const services = createAgentServices({ repository: repo, provider })

    let caught: AgentError | undefined
    try {
      await services.startRun({
        deviceId: "dev-1",
        idempotencyKey: "start-run-noroom----------aa",
        projectId: "proj-noroom",
        roomId: "room-nonexistent",
        providerType: "fake",
        budget: { maxTokens: 1000, maxDurationMs: 60000, maxRetries: 0 },
        actorId: "user-a"
      })
    } catch (error) {
      caught = error as AgentError
    }
    expect(caught).toBeInstanceOf(AgentError)
    expect(caught?.code).toBe("not_found")
  })

  it("getArtifactsForRun returns empty array for a run with no artifacts", async () => {
    harness.seedProject("proj-empty", "Empty Project")
    harness.seedUser({ userId: "user-a", projectId: "proj-empty", role: "contributor" })
    harness.seedRoom({ id: "room-empty", projectId: "proj-empty", name: "Empty Room" })

    const output: AgentProviderOutput = {
      done: true,
      artifacts: []
    }
    const provider = createFakeAgentProvider({ outputs: [output] })
    const repo = createAgentRepository({ database: harness.database })
    const services = createAgentServices({ repository: repo, provider })

    const started = await services.startRun({
      deviceId: "dev-1",
      idempotencyKey: "start-run-empty-art-------aa",
      projectId: "proj-empty",
      roomId: "room-empty",
      providerType: "fake",
      budget: { maxTokens: 1000, maxDurationMs: 60000, maxRetries: 0 },
      actorId: "user-a"
    })

    const artifacts = services.getArtifactsForRun(started.value.run.id)
    expect(artifacts).toEqual([])
  })
})

/* ------------------------------------------------------------------ *
 * Helpers                                                             *
 * ------------------------------------------------------------------ */

function countEvents(harness: AgentTestHarness): number {
  return (harness.database.prepare("SELECT COUNT(*) AS c FROM domain_events").get() as { c: number }).c
}

function countAuditRows(harness: AgentTestHarness): number {
  return (harness.database.prepare("SELECT COUNT(*) AS c FROM audit_log").get() as { c: number }).c
}
