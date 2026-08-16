import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AcpProfileNotFoundError,
  AcpProfileRevisionConflictError,
  type AcpProfileCatalog,
  type AcpProfileDescriptor
} from "@planweave-ai/runtime";
import { AcpProfilesJsonError, registerAcpProfilesCommand } from "../commands/acpProfiles.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function profile(): AcpProfileDescriptor {
  return {
    version: "planweave.acp-profile/v1",
    id: "custom-acp",
    agentId: "custom-agent",
    displayName: "Custom Agent",
    host: { kind: "native" },
    launch: { command: "/opt/custom-acp", args: ["serve"] },
    environment: [{ name: "CUSTOM_API_KEY", required: true }],
    shutdown: { eofDrainMs: 100, terminateGraceMs: 100, cleanupDeadlineMs: 1_000 },
    capabilities: { required: ["session", "prompt"], optional: [] },
    connection: { mode: "dedicated" }
  };
}

function catalog(revision: number, profiles: AcpProfileDescriptor[]): AcpProfileCatalog {
  return { version: "planweave.acp-profile-catalog/v1", revision, profiles };
}

describe("acp-profiles CLI", () => {
  it("registers all explicit management subcommands", () => {
    const program = new Command();
    registerAcpProfilesCommand(program);
    const command = program.commands.find((candidate) => candidate.name() === "acp-profiles");
    expect(command?.commands.map((candidate) => candidate.name())).toEqual([
      "list",
      "show",
      "register",
      "update",
      "remove"
    ]);
    expect(command?.helpInformation()).toContain("register -> planweave trust executor");
  });

  it("returns stable JSON envelopes for conflicts, missing profiles, and invalid descriptors", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-acp-profiles-errors-"));
    roots.push(root);
    const invalidFile = join(root, "invalid.json");
    await writeFile(invalidFile, JSON.stringify({ version: "invalid" }), "utf8");
    const manager = {
      list: vi.fn(async () => catalog(0, [])),
      show: vi.fn(async () => {
        throw new AcpProfileNotFoundError("missing");
      }),
      register: vi.fn(async () => {
        throw new AcpProfileRevisionConflictError(2, 3);
      }),
      update: vi.fn(async () => catalog(0, [])),
      remove: vi.fn(async () => catalog(0, []))
    };

    const invoke = async (args: string[]) => {
      const program = new Command();
      program.exitOverride();
      registerAcpProfilesCommand(program, manager);
      return program.parseAsync(["acp-profiles", ...args], { from: "user" });
    };
    await expect(invoke(["show", "missing", "--json"])).rejects.toMatchObject({
      envelope: { error: { code: "profile_not_found", profileId: "missing" } }
    });
    await expect(
      invoke(["register", "--file", invalidFile, "--expected-revision", "0", "--json"])
    ).rejects.toMatchObject({
      envelope: { error: { code: "invalid_profile_descriptor" } }
    });
    const validFile = join(root, "valid.json");
    await writeFile(validFile, JSON.stringify(profile()), "utf8");
    await expect(
      invoke(["register", "--file", validFile, "--expected-revision", "2", "--json"])
    ).rejects.toEqual(expect.any(AcpProfilesJsonError));
    await expect(
      invoke(["register", "--file", validFile, "--expected-revision", "2", "--json"])
    ).rejects.toMatchObject({
      envelope: { error: { code: "revision_conflict", expectedRevision: 2, actualRevision: 3 } }
    });
  });

  it("passes CAS revisions and prints descriptors without environment values", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-acp-profiles-cli-"));
    roots.push(root);
    const file = join(root, "profile.json");
    await writeFile(file, JSON.stringify(profile()), "utf8");
    const manager = {
      list: vi.fn(async () => catalog(0, [])),
      show: vi.fn(async () => ({ revision: 1, profile: profile() })),
      register: vi.fn(async () => catalog(1, [profile()])),
      update: vi.fn(async () => catalog(2, [profile()])),
      remove: vi.fn(async () => catalog(3, []))
    };
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));

    for (const args of [
      ["register", "--file", file, "--expected-revision", "0", "--json"],
      ["update", "custom-acp", "--file", file, "--expected-revision", "1", "--json"],
      ["show", "custom-acp", "--json"],
      ["remove", "custom-acp", "--expected-revision", "2", "--json"]
    ]) {
      const program = new Command();
      program.exitOverride();
      registerAcpProfilesCommand(program, manager);
      await program.parseAsync(["acp-profiles", ...args], { from: "user" });
    }

    expect(manager.register).toHaveBeenCalledWith({ expectedRevision: 0, profile: profile() });
    expect(manager.update).toHaveBeenCalledWith({
      expectedRevision: 1,
      profileId: "custom-acp",
      profile: profile()
    });
    expect(manager.remove).toHaveBeenCalledWith({
      expectedRevision: 2,
      profileId: "custom-acp"
    });
    expect(output.join("\n")).toContain("CUSTOM_API_KEY");
    expect(output.join("\n")).not.toContain("secret-value");
  });
});
