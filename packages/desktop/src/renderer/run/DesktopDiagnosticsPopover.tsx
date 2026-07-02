import { useState, type ReactNode } from "react";
import type { ValidationIssue } from "@planweave-ai/runtime";
import { AlertTriangleIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import type { FloatingAutoRunTranslator } from "./floatingAutoRunTypes";

type DesktopDiagnosticsPopoverProps = {
  diagnostics: ValidationIssue[];
  disabled: boolean;
  t: FloatingAutoRunTranslator;
};

function DisclosureSection({
  children,
  defaultOpen = false,
  testId,
  title
}: {
  children: ReactNode;
  defaultOpen?: boolean;
  testId?: string;
  title: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-md border bg-muted/20 text-xs" data-testid={testId}>
      <Button
        className="h-auto w-full justify-start gap-1.5 rounded-none px-2 py-1.5 text-left text-xs font-medium"
        size="sm"
        type="button"
        variant="ghost"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {open ? <ChevronDownIcon data-icon="inline-start" /> : <ChevronRightIcon data-icon="inline-start" />}
        {title}
      </Button>
      {open ? <div className="border-t border-border/70 p-2">{children}</div> : null}
    </div>
  );
}

function DesktopDiagnosticsList({
  diagnostics,
  emptyLabel,
  label
}: {
  diagnostics: ValidationIssue[];
  emptyLabel: string;
  label: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-xs font-semibold text-text-strong">{label}</div>
      {diagnostics.length > 0 ? (
        <div className="flex max-h-28 flex-col gap-1 overflow-y-auto">
          {diagnostics.map((diagnostic, index) => (
            <div
              className="rounded-md border border-border/70 bg-muted/30 px-2 py-1.5 text-xs"
              data-testid="desktop-performance-diagnostic"
              key={`${diagnostic.code}:${diagnostic.path ?? ""}:${index}`}
            >
              <div className="font-medium text-text-strong">{diagnostic.code}</div>
              <div className="break-words text-muted-foreground">{diagnostic.message}</div>
              {diagnostic.path ? <div className="mt-1 break-all text-text-faint">{diagnostic.path}</div> : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-md border border-border/70 bg-muted/30 px-2 py-1.5 text-xs text-muted-foreground">{emptyLabel}</div>
      )}
    </div>
  );
}

export function DesktopDiagnosticsPopover({ diagnostics, disabled, t }: DesktopDiagnosticsPopoverProps) {
  const hasPerformanceDiagnostics = diagnostics.length > 0;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          data-testid="desktop-diagnostics-trigger"
          size="icon-sm"
          variant={hasPerformanceDiagnostics ? "outline" : "ghost"}
          aria-label={t("viewDesktopDiagnostics")}
          title={t("viewDesktopDiagnostics")}
          disabled={disabled}
        >
          <AlertTriangleIcon data-icon="inline-start" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80" data-testid="desktop-diagnostics-popover">
        <PopoverHeader>
          <PopoverTitle>{t("desktopDiagnostics")}</PopoverTitle>
          <PopoverDescription>{hasPerformanceDiagnostics ? t("desktopDiagnosticsHint") : t("desktopDiagnosticsNoIssues")}</PopoverDescription>
        </PopoverHeader>
        <div className="flex flex-col gap-3">
          <DisclosureSection title={t("performanceDiagnostics")} testId="performance-diagnostics-section" defaultOpen={hasPerformanceDiagnostics}>
            <DesktopDiagnosticsList diagnostics={diagnostics} emptyLabel={t("desktopDiagnosticsNoIssues")} label={t("performanceDiagnostics")} />
          </DisclosureSection>
        </div>
      </PopoverContent>
    </Popover>
  );
}
