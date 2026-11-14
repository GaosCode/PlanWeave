import { AlertTriangleIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatAgentEndpointRunError } from "../collaboration/formatAgentEndpointRunError";
import type { createTranslator } from "../i18n";

type AppErrorBannerProps = {
  message: string | null;
  onDismiss: () => void;
  t: ReturnType<typeof createTranslator>;
};

export function AppErrorBanner({ message, onDismiss, t }: AppErrorBannerProps) {
  if (!message) {
    return null;
  }

  const displayMessage = formatAgentEndpointRunError(message, t);

  return (
    <div
      className="mx-auto my-2 flex w-[min(720px,calc(100%-2rem))] shrink-0 items-start gap-3 rounded-lg border border-destructive/40 bg-background p-3 text-sm"
      role="alert"
    >
      <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
      <div className="max-h-36 min-w-0 flex-1 overflow-auto whitespace-pre-wrap text-destructive [overflow-wrap:anywhere]">
        {displayMessage}
      </div>
      <Button size="icon-sm" variant="ghost" aria-label={t("dismissError")} onClick={onDismiss}>
        <XIcon data-icon="inline-start" />
      </Button>
    </div>
  );
}
