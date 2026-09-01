import { afterEach, describe, expect, it } from "vitest";
import { OwnerCanvasMaterializationRepository } from "../canvas/ownerCanvasMaterializationRepository.js";
import { HumanIdentityCredentialStore } from "../identity/humanIdentityCredentialStore.js";
import { MembershipStore } from "../identity/membershipStore.js";
import { applyMigrations } from "../migrations.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const databases: SqliteDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

async function fixture() {
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  return { database, repository: new OwnerCanvasMaterializationRepository(database) };
}

describe("OwnerCanvasMaterializationRepository", () => {
  it("registers one deterministic internal content scope per public owner scope", async () => {
    const { database, repository } = await fixture();
    const scope = {
      ownerHumanPrincipalId: "owner-a",
      projectId: "project-a",
      canvasId: "default"
    };

    const first = repository.ensureScope({ ...scope, createdAt: "2026-09-01T00:00:00.000Z" });
    const replay = repository.ensureScope({ ...scope, createdAt: "2026-09-01T01:00:00.000Z" });
    const otherOwner = repository.ensureScope({
      ...scope,
      ownerHumanPrincipalId: "owner-b",
      createdAt: "2026-09-01T00:00:00.000Z"
    });

    expect(replay).toEqual(first);
    expect(first.workspaceId).toMatch(/^owner-canvas-runtime:[a-f0-9]{64}$/);
    expect(otherOwner.workspaceId).not.toBe(first.workspaceId);
    expect(repository.findScope(scope)).toEqual(first);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM owner_canvas_materialization_scopes").get()
        ?.count
    ).toBe(2);
  });

  it("uses one canonical owner scope across an A to B to C identity alias chain", async () => {
    const { database, repository } = await fixture();
    const now = new Date("2030-01-01T00:00:00.000Z");
    const principals = new MembershipStore(database, () => now);
    principals.insertPrincipal("human-a", "Alice A");
    principals.insertPrincipal("human-b", "Alice B");
    principals.insertPrincipal("human-c", "Alice C");
    const identities = new HumanIdentityCredentialStore(database, () => now);
    const tokenA = identities.issue("human-a");
    const tokenB = identities.issue("human-b");
    const tokenC = identities.issue("human-c");
    identities.merge(tokenA.identityToken, tokenB.identityToken);
    identities.merge(tokenB.identityToken, tokenC.identityToken);

    const aliasScope = {
      ownerHumanPrincipalId: "human-a",
      projectId: "project-a",
      canvasId: "default"
    };
    const fromAlias = repository.ensureScope({
      ...aliasScope,
      createdAt: now.toISOString()
    });
    const fromCanonical = repository.ensureScope({
      ...aliasScope,
      ownerHumanPrincipalId: "human-c",
      createdAt: now.toISOString()
    });

    expect(fromAlias).toEqual(fromCanonical);
    expect(fromAlias.ownerHumanPrincipalId).toBe("human-c");
    expect(repository.findScope(aliasScope)).toEqual(fromCanonical);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM owner_canvas_materialization_scopes").get()
        ?.count
    ).toBe(1);
  });

  it("fails closed instead of creating a second scope for pre-canonical alias data", async () => {
    const { database, repository } = await fixture();
    const now = new Date("2030-01-01T00:00:00.000Z");
    const principals = new MembershipStore(database, () => now);
    principals.insertPrincipal("human-a", "Alice A");
    principals.insertPrincipal("human-b", "Alice B");
    const identities = new HumanIdentityCredentialStore(database, () => now);
    const tokenA = identities.issue("human-a");
    const tokenB = identities.issue("human-b");
    const scope = {
      ownerHumanPrincipalId: "human-a",
      projectId: "project-a",
      canvasId: "default"
    };
    repository.ensureScope({ ...scope, createdAt: now.toISOString() });
    identities.merge(tokenA.identityToken, tokenB.identityToken);

    expect(() => repository.findScope(scope)).toThrow(
      "owner_canvas_materialization_alias_scope_conflict"
    );
    expect(() =>
      repository.ensureScope({
        ...scope,
        ownerHumanPrincipalId: "human-b",
        createdAt: now.toISOString()
      })
    ).toThrow("owner_canvas_materialization_alias_scope_conflict");
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM owner_canvas_materialization_scopes").get()
        ?.count
    ).toBe(1);
  });
});
