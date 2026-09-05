import type { CollaborationSessionPhase } from "../../shared/collaboration.js";
import type { TranslationKey } from "../i18n";

export function projectSessionStatusLabel(
  phase: CollaborationSessionPhase,
  detail?: string | null
): TranslationKey {
  if (phase === "idle" && detail === "workspace_no_shared_projects")
    return "peopleProjectSessionNoSharedProject";
  switch (phase) {
    case "connected":
    case "ready":
      return "peopleProjectSessionConnected";
    case "connecting":
      return "peopleProjectSessionConnecting";
    case "error":
      return "peopleProjectSessionError";
    default:
      return "peopleProjectSessionDisconnected";
  }
}
