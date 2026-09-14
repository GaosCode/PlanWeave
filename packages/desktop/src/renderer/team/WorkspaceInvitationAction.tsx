import { useRef, useState } from "react";
import { CheckIcon, ClipboardCopyIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { createTranslator } from "../i18n";

export function WorkspaceInvitationAction({
  busy,
  unavailable = false,
  onCopy,
  t
}: {
  busy: boolean;
  unavailable?: boolean;
  onCopy: () => Promise<boolean>;
  t: ReturnType<typeof createTranslator>;
}) {
  const [state, setState] = useState<"idle" | "copying" | "copied" | "error">("idle");
  const pending = useRef(false);
  const copy = async () => {
    if (pending.current || busy) return;
    pending.current = true;
    setState("copying");
    try {
      setState((await onCopy()) ? "copied" : "error");
    } catch {
      // Clipboard and invitation issuance failures leave the page usable and allow retry.
      setState("error");
    } finally {
      pending.current = false;
    }
  };
  return (
    <div className="mb-2 ml-auto flex max-w-sm flex-col items-end gap-2">
      <Button
        size="sm"
        data-testid="workspace-copy-invitation"
        disabled={unavailable || busy || state === "copying"}
        onClick={() => void copy()}
      >
        <ClipboardCopyIcon className="size-3.5" />
        {t(state === "copying" ? "peopleWorking" : "workspaceCopyInvitation")}
      </Button>
      {unavailable ? (
        <p className="text-xs text-text-muted">{t("workspaceInvitationRequiresServerAccess")}</p>
      ) : null}
      {state === "copied" ? (
        <div role="status" className="text-right text-xs">
          <p className="flex items-center justify-end gap-1 text-emerald-700 dark:text-emerald-300">
            <CheckIcon className="size-3.5" />
            {t("workspaceInvitationCopySuccess")}
          </p>
          <p className="mt-1 text-text-muted">{t("workspaceInvitationCopyHint")}</p>
        </div>
      ) : null}
      {state === "error" ? (
        <p role="alert" className="text-xs text-destructive">
          {t("workspaceInvitationCopyFailed")}
        </p>
      ) : null}
    </div>
  );
}
