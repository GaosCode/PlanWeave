import { expect, it } from "vitest";
import { rememberedServerConnectionViewSchema } from "../shared/collaboration.js";
import { rememberedServerGroups } from "../renderer/settings/rememberedServerGroups";
it("groups the same Server while retaining each credential identity and preferring the active one", () => {
  const profiles = ["old", "active"].map((profileId) =>
    rememberedServerConnectionViewSchema.parse({
      profileId,
      displayName: "Team",
      workspaceDisplayName: "Team",
      serverBaseUrl: "https://server.example/",
      endpoint: {
        topology: "public_https",
        serverOrigin: "https://server.example/",
        allowedClientOrigins: ["https://server.example/"],
        tlsTrust: "system_ca"
      },
      hasDeviceCredential: true
    })
  );
  const groups = rememberedServerGroups(profiles, "active");
  expect(groups).toHaveLength(1);
  expect(groups[0]?.primary.profileId).toBe("active");
  expect(groups[0]?.connections).toEqual(profiles);
});
