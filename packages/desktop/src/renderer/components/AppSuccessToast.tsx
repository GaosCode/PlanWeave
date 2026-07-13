import { useEffect } from "react";
import { CheckCircleIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { createTranslator } from "../i18n";

type AppSuccessToastProps = {
  message: string | null;
  onDismiss: () => void;
  t: ReturnType<typeof createTranslator>;
};

export function AppSuccessToast({ message, onDismiss, t }: AppSuccessToastProps) {
  useEffect(() => {
    if (!message) {
      return undefined;
    }
    const timeout = window.setTimeout(onDismiss, 1800);
    return () => window.clearTimeout(timeout);
  }, [message, onDismiss]);

  if (!message) {
    return null;
  }

  return (
    <aside
      aria-live="polite"
      className="app-no-drag pointer-events-auto fixed right-4 bottom-4 z-50 flex w-[min(320px,calc(100vw-2rem))] items-center gap-3 rounded-md border border-state-success/35 bg-state-success-surface p-3 text-sm text-text-strong shadow-xl animate-in fade-in slide-in-from-right-4 duration-[var(--motion-duration-base)] ease-[var(--motion-ease-emphasized)]"
      data-testid="app-success-toast"
      role="status"
    >
      <CheckCircleIcon className="size-4 shrink-0 text-state-success" aria-hidden="true" />
      <div className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">{message}</div>
      <Button aria-label={t("close")} size="icon-sm" variant="ghost" onClick={onDismiss}>
        <XIcon data-icon="inline-start" />
      </Button>
    </aside>
  );
}
