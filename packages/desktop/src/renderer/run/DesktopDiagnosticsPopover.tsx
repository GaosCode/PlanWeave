import { useState, type ReactNode } from "react";
import { ChevronDownIcon, ChevronRightIcon, CopyIcon, GaugeIcon, Wand2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger
} from "@/components/ui/popover";
import {
  diagnosticFixActionFor,
  type DiagnosticFixAction,
  type DiagnosticFixContext
} from "../diagnosticFixActions";
import {
  groupDesktopDiagnostics,
  type DesktopDiagnostic,
  type DesktopDiagnosticSource
} from "../diagnostics";
import type { TranslationKey } from "../i18n";
import type { FloatingAutoRunTranslator } from "./floatingAutoRunTypes";

type DesktopDiagnosticsPopoverProps = {
  actionContext?: DiagnosticFixContext | null;
  diagnostics: DesktopDiagnostic[];
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
        {open ? (
          <ChevronDownIcon data-icon="inline-start" />
        ) : (
          <ChevronRightIcon data-icon="inline-start" />
        )}
        {title}
      </Button>
      {open ? <div className="border-t border-border/70 p-2">{children}</div> : null}
    </div>
  );
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

function DiagnosticActionButton({
  action,
  actionKey,
  actionContext,
  disabled,
  onFinish,
  onStart,
  t
}: {
  action: DiagnosticFixAction;
  actionKey: string;
  actionContext: DiagnosticFixContext;
  disabled: boolean;
  onFinish: () => void;
  onStart: (actionKey: string) => void;
  t: FloatingAutoRunTranslator;
}) {
  return (
    <Button
      className="mt-1 h-6 gap-1 px-1.5 text-[11px]"
      data-testid={`diagnostic-${action.kind}-action`}
      disabled={disabled}
      size="sm"
      type="button"
      variant="outline"
      onClick={() => {
        onStart(actionKey);
        void action
          .run()
          .catch((caught: unknown) => {
            actionContext.setError(errorMessage(caught));
          })
          .finally(onFinish);
      }}
    >
      {action.kind === "apply" ? (
        <Wand2Icon data-icon="inline-start" />
      ) : (
        <CopyIcon data-icon="inline-start" />
      )}
      {t(action.labelKey)}
    </Button>
  );
}

function DesktopDiagnosticsList({
  actionContext,
  diagnostics,
  itemTestId,
  t
}: {
  actionContext?: DiagnosticFixContext | null;
  diagnostics: DesktopDiagnostic[];
  itemTestId: string;
  t: FloatingAutoRunTranslator;
}) {
  const [pendingActionKey, setPendingActionKey] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex max-h-28 flex-col overflow-y-auto">
        {diagnostics.map((diagnostic) => {
          const action = actionContext ? diagnosticFixActionFor(diagnostic, actionContext) : null;
          const actionKey = `${diagnostic.code}:${diagnostic.path ?? ""}:${diagnostic.fixId ?? ""}:${diagnostic.message}`;
          return (
            <div
              className="border-b border-border/70 px-2 py-1.5 text-xs last:border-b-0"
              data-testid={itemTestId}
              key={actionKey}
            >
              <div className="font-medium text-text-strong">{diagnostic.code}</div>
              <div className="break-words text-muted-foreground">{diagnostic.message}</div>
              {diagnostic.path ? (
                <div className="mt-1 break-all text-text-faint">{diagnostic.path}</div>
              ) : null}
              {diagnostic.severity || diagnostic.suggestedTool || diagnostic.fixId ? (
                <div className="mt-1 flex flex-wrap gap-1 text-[11px] text-text-faint">
                  {diagnostic.severity ? <span>{diagnostic.severity}</span> : null}
                  {diagnostic.suggestedTool ? <span>{diagnostic.suggestedTool}</span> : null}
                  {diagnostic.fixId ? <span>{diagnostic.fixId}</span> : null}
                </div>
              ) : null}
              {action && actionContext ? (
                <DiagnosticActionButton
                  action={action}
                  actionContext={actionContext}
                  actionKey={actionKey}
                  disabled={pendingActionKey !== null}
                  onFinish={() => setPendingActionKey(null)}
                  onStart={setPendingActionKey}
                  t={t}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const diagnosticTitleKeys = {
  performance: "performanceDiagnostics",
  package: "packageDiagnostics",
  search: "searchDiagnostics",
  runtime: "runtimeDiagnostics",
  project: "projectGraphDiagnostics",
  graphQuality: "graphQualityDiagnostics",
  other: "otherDiagnostics"
} satisfies Record<DesktopDiagnosticSource, TranslationKey>;

export function DesktopDiagnosticsPopover({
  actionContext,
  diagnostics,
  disabled,
  t
}: DesktopDiagnosticsPopoverProps) {
  const groups = groupDesktopDiagnostics(diagnostics);
  const defaultOpenSource =
    groups.find((group) => group.source === "performance")?.source ?? groups[0]?.source ?? null;
  const hasDiagnostics = groups.length > 0;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          data-testid="desktop-diagnostics-trigger"
          size="icon-sm"
          variant={hasDiagnostics ? "outline" : "ghost"}
          aria-label={t("viewDesktopDiagnostics")}
          title={t("viewDesktopDiagnostics")}
          disabled={disabled}
        >
          <GaugeIcon data-icon="inline-start" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80" data-testid="desktop-diagnostics-popover">
        <PopoverHeader>
          <PopoverTitle>{t("desktopDiagnostics")}</PopoverTitle>
          <PopoverDescription>{t("desktopDiagnosticsHint")}</PopoverDescription>
        </PopoverHeader>
        <div className="flex flex-col gap-3">
          {hasDiagnostics ? (
            groups.map((group) => {
              const label = t(diagnosticTitleKeys[group.source]);
              return (
                <DisclosureSection
                  title={`${label} (${group.diagnostics.length})`}
                  testId={`${group.source}-diagnostics-section`}
                  defaultOpen={group.source === defaultOpenSource}
                  key={group.source}
                >
                  <DesktopDiagnosticsList
                    actionContext={actionContext}
                    diagnostics={group.diagnostics}
                    itemTestId={`desktop-${group.source}-diagnostic`}
                    t={t}
                  />
                </DisclosureSection>
              );
            })
          ) : (
            <div
              className="rounded-md border border-border/70 bg-muted/20 px-2 py-1.5 text-xs text-muted-foreground"
              data-testid="desktop-diagnostics-empty"
            >
              {t("desktopDiagnosticsNoIssues")}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
