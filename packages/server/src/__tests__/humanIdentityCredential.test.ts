import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, latestCentralSchemaVersion } from "../migrations.js";
import { HumanPrincipalIdentity } from "../identity/humanPrincipalIdentity.js";
import {
  HumanIdentityCredentialError,
  HumanIdentityCredentialStore
} from "../identity/humanIdentityCredentialStore.js";
import { MembershipStore } from "../identity/membershipStore.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const databases: SqliteDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("human identity credentials", () => {
  it("issues, renews, and revokes independently of workspace sessions", async () => {
    expect(latestCentralSchemaVersion).toBe(69);
    const database = await openServerDatabase(":memory:", 5_000);
    databases.push(database);
    applyMigrations(database);
    const now = new Date("2030-01-01T00:00:00.000Z");
    new MembershipStore(database, () => now).insertPrincipal("human-a", "Alice");
    const store = new HumanIdentityCredentialStore(database, () => now, 60_000);
    const issued = store.issue("human-a");
    expect(issued.identityToken.startsWith("pw_hid_")).toBe(true);
    expect(store.authenticate(issued.identityToken)?.humanPrincipalId).toBe("human-a");
    const renewed = store.renew(issued.identityToken);
    expect(store.authenticate(issued.identityToken)).toBeUndefined();
    expect(store.authenticate(renewed.identityToken)?.humanPrincipalId).toBe("human-a");
    store.revoke(renewed.identityToken, "lost device");
    expect(store.authenticate(renewed.identityToken)).toBeUndefined();
    expect(() => store.renew(renewed.identityToken)).toThrow(HumanIdentityCredentialError);
  });

  it("merges split principals only when both identity tokens are valid", async () => {
    const database = await openServerDatabase(":memory:", 5_000);
    databases.push(database);
    applyMigrations(database);
    const now = new Date("2030-01-01T00:00:00.000Z");
    const principals = new MembershipStore(database, () => now);
    principals.insertPrincipal("human-a", "Alice A");
    principals.insertPrincipal("human-b", "Alice B");
    const store = new HumanIdentityCredentialStore(database, () => now);
    const tokenA = store.issue("human-a");
    const tokenB = store.issue("human-b");
    expect(() => store.merge(tokenA.identityToken, tokenA.identityToken)).toThrow(
      HumanIdentityCredentialError
    );
    const merged = store.merge(tokenB.identityToken, tokenA.identityToken);
    expect(merged).toMatchObject({
      alreadyEquivalent: false,
      sourceHumanPrincipalId: "human-b",
      canonicalHumanPrincipalId: "human-a"
    });
    expect(merged.mergeId).toMatch(/^identity-merge-/);
    expect(store.resolveCanonicalHumanPrincipalId("human-b")).toBe("human-a");
    expect(store.merge(tokenB.identityToken, tokenA.identityToken)).toEqual({
      alreadyEquivalent: true,
      canonicalHumanPrincipalId: "human-a"
    });
    const again = store.issue("human-b");
    expect(again.record.humanPrincipalId).toBe("human-a");
  });

  it("keeps A→B→C alias chains equivalent for identity and ownership lookup", async () => {
    const database = await openServerDatabase(":memory:", 5_000);
    databases.push(database);
    applyMigrations(database);
    const now = new Date("2030-01-01T00:00:00.000Z");
    const principals = new MembershipStore(database, () => now);
    principals.insertPrincipal("human-a", "Alice A");
    principals.insertPrincipal("human-b", "Alice B");
    principals.insertPrincipal("human-c", "Alice C");
    const store = new HumanIdentityCredentialStore(database, () => now);
    const tokenA = store.issue("human-a");
    const tokenB = store.issue("human-b");
    const tokenC = store.issue("human-c");
    const first = store.merge(tokenA.identityToken, tokenB.identityToken);
    const second = store.merge(tokenB.identityToken, tokenC.identityToken);
    expect(store.resolveCanonicalHumanPrincipalId("human-a")).toBe("human-c");
    expect(store.resolveCanonicalHumanPrincipalId("human-b")).toBe("human-c");
    expect(store.resolveCanonicalHumanPrincipalId("human-c")).toBe("human-c");
    expect(new HumanPrincipalIdentity(database).equivalentIds("human-c").sort()).toEqual([
      "human-a",
      "human-b",
      "human-c"
    ]);
    const aliases = database
      .prepare(
        `SELECT alias_human_principal_id,canonical_human_principal_id,merge_id
         FROM human_principal_aliases ORDER BY alias_human_principal_id`
      )
      .all() as Array<{
      alias_human_principal_id: string;
      canonical_human_principal_id: string;
      merge_id: string;
    }>;
    expect(aliases).toEqual([
      {
        alias_human_principal_id: "human-a",
        canonical_human_principal_id: "human-b",
        merge_id: first.mergeId
      },
      {
        alias_human_principal_id: "human-b",
        canonical_human_principal_id: "human-c",
        merge_id: second.mergeId
      }
    ]);
    const audits = database
      .prepare(
        `SELECT merge_id,source_human_principal_id,canonical_human_principal_id
         FROM human_principal_merges ORDER BY merged_at`
      )
      .all() as Array<{
      merge_id: string;
      source_human_principal_id: string;
      canonical_human_principal_id: string;
    }>;
    expect(audits).toEqual([
      {
        merge_id: first.mergeId,
        source_human_principal_id: "human-a",
        canonical_human_principal_id: "human-b"
      },
      {
        merge_id: second.mergeId,
        source_human_principal_id: "human-b",
        canonical_human_principal_id: "human-c"
      }
    ]);
    const transitive = store.merge(tokenA.identityToken, tokenC.identityToken);
    expect(transitive).toEqual({
      alreadyEquivalent: true,
      canonicalHumanPrincipalId: "human-c"
    });
    expect(store.merge(tokenC.identityToken, tokenA.identityToken)).toEqual({
      alreadyEquivalent: true,
      canonicalHumanPrincipalId: "human-c"
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM human_principal_merges").get()).toEqual({
      count: 2
    });
    expect(store.resolveCanonicalHumanPrincipalId("human-a")).toBe("human-c");
  });

  it("renews at the active credential limit without counting the rotated credential", async () => {
    const database = await openServerDatabase(":memory:", 5_000);
    databases.push(database);
    applyMigrations(database);
    const now = new Date("2030-01-01T00:00:00.000Z");
    new MembershipStore(database, () => now).insertPrincipal("human-a", "Alice");
    const store = new HumanIdentityCredentialStore(database, () => now);
    let latest = store.issue("human-a");
    for (let index = 1; index < 32; index += 1) {
      latest = store.issue("human-a");
    }
    expect(() => store.issue("human-a")).toThrow(HumanIdentityCredentialError);
    const renewed = store.renew(latest.identityToken);
    expect(store.authenticate(latest.identityToken)).toBeUndefined();
    expect(store.authenticate(renewed.identityToken)?.humanPrincipalId).toBe("human-a");
  });

  it("counts equivalent-set credentials for issue, renew, recover, and merge", async () => {
    const database = await openServerDatabase(":memory:", 5_000);
    databases.push(database);
    applyMigrations(database);
    const now = new Date("2030-01-01T00:00:00.000Z");
    const principals = new MembershipStore(database, () => now);
    principals.insertPrincipal("human-a", "Alice A");
    principals.insertPrincipal("human-b", "Alice B");
    principals.insertPrincipal("human-c", "Alice C");
    const store = new HumanIdentityCredentialStore(database, () => now);
    const tokenA = store.issue("human-a");
    const tokenB = store.issue("human-b");
    const tokenC = store.issue("human-c");
    for (let index = 1; index < 16; index += 1) store.issue("human-a");
    for (let index = 1; index < 15; index += 1) store.issue("human-b");
    store.merge(tokenA.identityToken, tokenB.identityToken);
    store.merge(tokenB.identityToken, tokenC.identityToken);
    expect(() => store.issue("human-c")).toThrow(HumanIdentityCredentialError);
    const renewed = store.renew(tokenC.identityToken);
    expect(store.authenticate(tokenC.identityToken)).toBeUndefined();
    expect(store.authenticate(renewed.identityToken)?.humanPrincipalId).toBe("human-c");
    expect(() => store.issue("human-c")).toThrow(HumanIdentityCredentialError);
  });

  it("rejects a merge that would exceed 32 active credentials across both identity sets", async () => {
    const database = await openServerDatabase(":memory:", 5_000);
    databases.push(database);
    applyMigrations(database);
    const now = new Date("2030-01-01T00:00:00.000Z");
    const principals = new MembershipStore(database, () => now);
    principals.insertPrincipal("human-a", "Alice A");
    principals.insertPrincipal("human-b", "Alice B");
    const store = new HumanIdentityCredentialStore(database, () => now);
    const tokenA = store.issue("human-a");
    const tokenB = store.issue("human-b");
    for (let index = 1; index < 16; index += 1) store.issue("human-a");
    for (let index = 1; index < 18; index += 1) store.issue("human-b");
    expect(() => store.merge(tokenA.identityToken, tokenB.identityToken)).toThrow(
      HumanIdentityCredentialError
    );
    expect(store.resolveCanonicalHumanPrincipalId("human-a")).toBe("human-a");
    expect(store.resolveCanonicalHumanPrincipalId("human-b")).toBe("human-b");
  });
});
