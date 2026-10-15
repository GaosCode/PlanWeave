import { join } from "node:path";
import { z } from "zod";
import { exampleHumanIdentityToken } from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import { CollaborationService } from "../main/collaboration/collaborationService.js";
import { OperatorControlClient } from "../main/operatorControl/OperatorControlClient.js";
import { WorkspaceExecutionDesktopService } from "../main/workspaceExecutionDesktopService.js";
import { desktopWorkspaceExecutionStartInputSchema } from "../shared/workspaceExecution.js";

const config = z
  .object({
    root: z.string(),
    token: z.string(),
    input: desktopWorkspaceExecutionStartInputSchema
  })
  .parse(JSON.parse(process.argv[2]));
let sequence = 0;
const responses = new Map<number, (value: Response) => void>();
const client = new OperatorControlClient({
  profile: {
    profileId: "profile-server",
    displayName: "Server",
    serverBaseUrl: "https://operator.test/",
    allowInsecureTransport: false
  },
  credential: {
    getOperatorToken: () => config.token,
    getHumanIdentityToken: () => exampleHumanIdentityToken
  },
  request: async (input, init) => {
    if (new URL(String(input)).pathname === "/api/v1/agent-endpoints") {
      process.send!({ kind: "catalog-paused" });
      await new Promise<void>(() => {});
    }
    const id = ++sequence;
    const response = new Promise<Response>((resolve) => responses.set(id, resolve));
    process.send!({
      kind: "request",
      id,
      url: String(input),
      method: init?.method,
      body: init?.body
    });
    return response;
  }
});
const collaboration = new CollaborationService({
  profileStorePaths: { profilesPath: join(config.root, "profiles.json") },
  workspaceProfileStorePaths: { profilesPath: join(config.root, "workspace-profiles.json") },
  credentialsPath: join(config.root, "credentials.json"),
  invitationsPath: join(config.root, "invitations.json")
});
const service = new WorkspaceExecutionDesktopService(
  collaboration,
  { withExecutionProfile: async (_profile, operation) => operation(client) },
  config.root
);
process.on("message", async (raw) => {
  const message = z
    .discriminatedUnion("kind", [
      z.object({
        kind: z.literal("response"),
        id: z.number(),
        status: z.number(),
        body: z.string()
      }),
      z.object({ kind: z.literal("stop") }),
      z.object({ kind: z.literal("exit") })
    ])
    .parse(raw);
  if (message.kind === "response") {
    responses.get(message.id)!(new Response(message.body, { status: message.status }));
    responses.delete(message.id);
  } else if (message.kind === "exit") {
    process.exit(91);
  } else {
    const result = await service.cancelStart({
      input: config.input,
      startRequestId: config.input.startRequestId!,
      actionId: "stop-real-server",
      reason: "Desktop Auto Run stop requested."
    });
    process.send!({ kind: "stop-persisted", confirmed: result.confirmed });
  }
});
void service.start(config.input).then(
  () => process.send!({ kind: "unexpected-start-completion" }),
  (error: unknown) => process.send!({ kind: "start-error", error: String(error) })
);
