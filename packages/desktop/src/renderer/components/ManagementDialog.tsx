import type { ReactNode } from "react";
import { Dialog } from "radix-ui";
import { XIcon } from "lucide-react";
import { Button } from "./ui/button";
import type { createTranslator } from "../i18n";

export function ManagementDialog({
  open,
  onOpenChange,
  title,
  children,
  t
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  t: ReturnType<typeof createTranslator>;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/20 backdrop-blur-[2px]" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 z-50 flex max-h-[85vh] w-[min(48rem,calc(100vw-3rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-background text-text shadow-xl"
        >
          <div className="flex shrink-0 items-center justify-between border-b border-border/70 px-6 py-4">
            <Dialog.Title className="text-base font-semibold text-text-strong">
              {title}
            </Dialog.Title>
            <Dialog.Close asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("close")}
                data-testid="management-dialog-close"
              >
                <XIcon className="size-4" />
              </Button>
            </Dialog.Close>
          </div>
          <div className="min-h-0 overflow-y-auto p-6">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
