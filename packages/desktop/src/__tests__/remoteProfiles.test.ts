import { access, mkdtemp, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, describe, expect, it } from "vitest"
import { desktopHomePaths } from "../main/planweaveHomePaths"
import { createRemoteProfile, updateRemoteProfile, deleteRemoteProfile, getRemoteProfile, listRemoteProfiles } from "../main/remoteProfiles"

const tempRoots: string[] = []

async function tempHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "planweave-remote-profiles-"))
  tempRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("remote profiles CRUD", () => {
  it("creates and reads a remote profile", async () => {
    const home = await tempHome()
    process.env.PLANWEAVE_HOME = home

    const profile = await createRemoteProfile({
      name: "Test Server",
      serverUrl: "https://planweave.example.com",
      deviceId: "dev-001",
      apiKey: "sk-test-123"
    })

    expect(profile.name).toBe("Test Server")
    expect(profile.serverUrl).toBe("https://planweave.example.com")
    expect(profile.deviceId).toBe("dev-001")
    expect(profile).not.toHaveProperty("apiKey")
    expect(profile.id).toBeTruthy()

    const read = await getRemoteProfile(profile.id)
    expect(read).toEqual(profile)

    delete process.env.PLANWEAVE_HOME
  })

  it("normalizes server URLs", async () => {
    const home = await tempHome()
    process.env.PLANWEAVE_HOME = home

    const profile = await createRemoteProfile({
      name: "Trailing Slash",
      serverUrl: "https://planweave.example.com/",
      deviceId: "dev-002",
      apiKey: "sk-test-456"
    })

    expect(profile.serverUrl).toBe("https://planweave.example.com")

    const noScheme = await createRemoteProfile({
      name: "No Scheme",
      serverUrl: "planweave.example.com",
      deviceId: "dev-003",
      apiKey: "sk-test-789"
    })

    expect(noScheme.serverUrl).toBe("https://planweave.example.com")

    delete process.env.PLANWEAVE_HOME
  })

  it("updates a remote profile", async () => {
    const home = await tempHome()
    process.env.PLANWEAVE_HOME = home

    const profile = await createRemoteProfile({
      name: "Original",
      serverUrl: "https://old.example.com",
      deviceId: "dev-old",
      apiKey: "sk-old"
    })

    const updated = await updateRemoteProfile(profile.id, {
      name: "Updated",
      serverUrl: "https://new.example.com"
    })

    expect(updated.name).toBe("Updated")
    expect(updated.serverUrl).toBe("https://new.example.com")
    expect(updated.deviceId).toBe("dev-old")
    expect(updated).not.toHaveProperty("apiKey")

    delete process.env.PLANWEAVE_HOME
  })

  it("throws when updating a non-existent profile", async () => {
    const home = await tempHome()
    process.env.PLANWEAVE_HOME = home

    await expect(updateRemoteProfile("0000000000000000", { name: "Test" }))
      .rejects.toThrow("Remote profile '0000000000000000' not found")

    delete process.env.PLANWEAVE_HOME
  })

  it("deletes a remote profile", async () => {
    const home = await tempHome()
    process.env.PLANWEAVE_HOME = home

    const profile = await createRemoteProfile({
      name: "To Delete",
      serverUrl: "https://delete.example.com",
      deviceId: "dev-del",
      apiKey: "sk-del"
    })

    await deleteRemoteProfile(profile.id)
    const read = await getRemoteProfile(profile.id)
    expect(read).toBeNull()

    delete process.env.PLANWEAVE_HOME
  })

  it("lists all remote profiles", async () => {
    const home = await tempHome()
    process.env.PLANWEAVE_HOME = home

    const p1 = await createRemoteProfile({ name: "A", serverUrl: "https://a.example.com", deviceId: "d1", apiKey: "k1" })
    const p2 = await createRemoteProfile({ name: "B", serverUrl: "https://b.example.com", deviceId: "d2", apiKey: "k2" })

    const profiles = await listRemoteProfiles()
    expect(profiles.length).toBeGreaterThanOrEqual(2)

    const ids = profiles.map((p) => p.id)
    expect(ids).toContain(p1.id)
    expect(ids).toContain(p2.id)

    delete process.env.PLANWEAVE_HOME
  })

  it("returns empty array when no profiles exist", async () => {
    const home = await tempHome()
    process.env.PLANWEAVE_HOME = home

    const profiles = await listRemoteProfiles()
    expect(profiles).toEqual([])

    delete process.env.PLANWEAVE_HOME
  })

  it("rejects profile-id traversal and stores credentials with owner-only permissions", async () => {
    const home = await tempHome()
    process.env.PLANWEAVE_HOME = home

    const profile = await createRemoteProfile({ name: "Secure", serverUrl: "https://secure.example.com", deviceId: "device", apiKey: "secret" })
    await expect(getRemoteProfile("../../github-auth")).rejects.toThrow("Invalid remote profile id")
    await expect(deleteRemoteProfile("../../github-auth")).rejects.toThrow("Invalid remote profile id")

    const path = join(desktopHomePaths().planweaveHome, "desktop", "remote-profiles", `${profile.id}.json`)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    delete process.env.PLANWEAVE_HOME
  })
})
