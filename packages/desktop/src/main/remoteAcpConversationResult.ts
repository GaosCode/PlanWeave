import {
  desktopRemoteAcpConversationResultSchema,
  type DesktopRemoteAcpConversationPage
} from "../shared/remoteAcpConversation.js";

export async function remoteAcpConversationResult(
  operation: () => Promise<DesktopRemoteAcpConversationPage>
) {
  try {
    return desktopRemoteAcpConversationResultSchema.parse({ ok: true, value: await operation() });
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? error.code
        : error instanceof Error
          ? error.message
          : null;
    return desktopRemoteAcpConversationResultSchema.parse({
      ok: false,
      error:
        typeof code === "string" && /^[a-z][a-z0-9_]{1,255}$/.test(code)
          ? code
          : "acp_conversation_request_failed"
    });
  }
}
