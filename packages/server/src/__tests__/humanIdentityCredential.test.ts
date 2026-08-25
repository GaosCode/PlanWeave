import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, latestCentralSchemaVersion } from "../migrations.js";
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
    expect(latestCentralSchemaVersion).toBe(61);
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
    expect(merged.sourceHumanPrincipalId).toBe("human-b");
    expect(merged.canonicalHumanPrincipalId).toBe("human-a");
    expect(store.resolveCanonicalHumanPrincipalId("human-b")).toBe("human-a");
    expect(store.merge(tokenB.identityToken, tokenA.identityToken).mergeId).toBe(merged.mergeId);
    const again = store.issue("human-b");
    expect(again.record.humanPrincipalId).toBe("human-a");
  });
});
