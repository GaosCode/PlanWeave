import { memo, useState } from "react";
import type { AcpTimelineItem } from "@planweave-ai/runtime";
import { ArrowDownIcon, BotIcon, ChevronRightIcon, UserIcon, WrenchIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { createTranslator } from "../i18n";
import { useConversationAutoScroll } from "../hooks/useConversationAutoScroll";
import { SafeMarkdown } from "./SafeMarkdown";

function readablePayload(value: string | null): string | null {
  if (value === null) return null;
  if (value === "") return "Empty string";
  try {
    const parsed: unknown = JSON.parse(value);
    return structuredPayloadText(parsed);
  } catch {
    return value;
  }
}

function structuredPayloadText(value: unknown, depth = 0): string {
  if (value === null) return "null";
  if (typeof value === "string") return value === "" ? "Empty string" : value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  const indent = "  ".repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${indent}[]`;
    return value.map((item) => `${indent}- ${structuredPayloadText(item, depth + 1).trimStart()}`).join("\n");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return `${indent}{}`;
    return entries.map(([key, item]) => {
      const rendered = structuredPayloadText(item, depth + 1);
      return typeof item === "object" && item !== null
        ? `${indent}${key}:\n${rendered}`
        : `${indent}${key}: ${rendered}`;
    }).join("\n");
  }
  return String(value);
}

export function AcpConversationTimeline({ changeKey, timeline, t }: {
  changeKey: number;
  timeline: readonly AcpTimelineItem[];
  t: ReturnType<typeof createTranslator>;
}) {
  const { following, onScroll, scrollToBottom, viewportRef } = useConversationAutoScroll(changeKey);

  return (
    <div className="relative min-h-0 flex-1">
      <div className="h-full overflow-y-auto rounded-xl border bg-muted/15 p-4" ref={viewportRef} onScroll={onScroll} data-testid="acp-conversation-viewport">
        <AcpConversationItems timeline={timeline} t={t} />
      </div>
      {!following ? <Button className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-md" size="sm" variant="secondary" onClick={() => scrollToBottom()}><ArrowDownIcon />{t("acpJumpToLatest")}</Button> : null}
    </div>
  );
}

type AcpConversationPresentation = "inspector" | "workspace";

export function AcpConversationItems({ presentation = "inspector", timeline, t }: {
  presentation?: AcpConversationPresentation;
  timeline: readonly AcpTimelineItem[];
  t: ReturnType<typeof createTranslator>;
}) {
  const workspace = presentation === "workspace";
  return timeline.length ? <div className="space-y-4">
    {timeline.map((item) => item.kind === "tool" ? (
      <ToolCard key={`tool-${item.callId}`} presentation={presentation} tool={item} t={t} />
    ) : item.kind === "plan" ? (
      <details className="rounded-lg border bg-background/70 px-3 py-2 text-xs" key={`plan-${item.sequence}`}>
        <summary className="cursor-pointer font-medium">{t("acpPlanUpdate")}</summary>
        <div className="mt-2 text-muted-foreground"><SafeMarkdown markdown={item.content} /></div>
      </details>
    ) : item.kind === "output" ? (
      <details className={`${workspace ? "" : "ml-10 "}rounded-lg border bg-muted/40 px-3 py-2 text-xs`} key={`output-${item.sequence}`}>
        <summary className="cursor-pointer font-medium">{item.stream === "terminal" ? t("acpTerminalOutput") : item.stream}</summary>
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px]">{item.content}</pre>
      </details>
    ) : (
      <MessageCard item={item} key={`message-${item.sequence}`} presentation={presentation} t={t} />
    ))}
  </div> : <div className="py-12 text-center text-xs text-muted-foreground">{t("acpConversationEmpty")}</div>;
}

const MessageCard = memo(function MessageCard({ item, presentation, t }: {
  item: Extract<AcpTimelineItem, { kind: "message" }>;
  presentation: AcpConversationPresentation;
  t: ReturnType<typeof createTranslator>;
}) {
  const user = item.role === "user";
  if (presentation === "workspace") {
    return user ? (
      <article className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-tr-sm bg-muted px-4 py-2.5 text-sm">
          <div className="whitespace-pre-wrap break-words">{item.content}</div>
        </div>
      </article>
    ) : (
      <article className="w-full text-sm">
        <SafeMarkdown markdown={item.content} />
      </article>
    );
  }
  return <article className={`flex gap-3 ${user ? "flex-row-reverse" : ""}`}>
    <div className={`mt-1 flex size-7 shrink-0 items-center justify-center rounded-full ${user ? "bg-primary text-primary-foreground" : "border bg-background"}`}>{user ? <UserIcon className="size-3.5" /> : <BotIcon className="size-3.5" />}</div>
    <div className={`max-w-[86%] space-y-1 ${user ? "items-end" : ""}`}>
      <div className={`text-[10px] font-medium uppercase tracking-wide text-muted-foreground ${user ? "text-right" : ""}`}>{user ? t("acpRoleUser") : t("acpRoleAssistant")}</div>
      <div className={user ? "rounded-2xl rounded-tr-sm bg-primary px-4 py-2.5 text-sm text-primary-foreground" : "rounded-2xl rounded-tl-sm border bg-background px-4 py-3 text-sm shadow-sm"}>
        {user ? <div className="whitespace-pre-wrap break-words">{item.content}</div> : <SafeMarkdown markdown={item.content} />}
      </div>
    </div>
  </article>;
}, (previous, next) =>
  previous.item.sequence === next.item.sequence &&
  previous.item.role === next.item.role &&
  previous.item.content === next.item.content &&
  previous.presentation === next.presentation &&
  previous.t === next.t);

const ToolCard = memo(function ToolCard({ presentation, tool, t }: {
  presentation: AcpConversationPresentation;
  tool: Extract<AcpTimelineItem, { kind: "tool" }>;
  t: ReturnType<typeof createTranslator>;
}) {
  const input = readablePayload(tool.input);
  const output = readablePayload(tool.output);
  if (presentation === "workspace") {
    return <WorkspaceToolRow input={input} output={output} tool={tool} t={t} />;
  }
  return <details className="group ml-10 rounded-lg border bg-background shadow-sm">
    <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs">
      <WrenchIcon className="size-3.5 text-muted-foreground" /><span className="min-w-0 flex-1 truncate font-medium">{tool.title}</span><Badge variant={tool.status === "failed" ? "destructive" : "secondary"}>{tool.status ?? t("acpToolPending")}</Badge>
    </summary>
    {(input || output) ? <div className="space-y-3 border-t px-3 py-3 text-xs">
      {input ? <ToolPayload label={t("acpToolInput")} value={input} /> : null}
      {output ? <ToolPayload label={t("acpToolOutput")} value={output} /> : null}
    </div> : null}
  </details>;
}, (previous, next) =>
  previous.tool.sequence === next.tool.sequence &&
  previous.tool.title === next.tool.title &&
  previous.tool.status === next.tool.status &&
  previous.tool.input === next.tool.input &&
  previous.tool.output === next.tool.output &&
  previous.presentation === next.presentation &&
  previous.t === next.t);

function WorkspaceToolRow({ input, output, tool, t }: {
  input: string | null;
  output: string | null;
  tool: Extract<AcpTimelineItem, { kind: "tool" }>;
  t: ReturnType<typeof createTranslator>;
}) {
  const [open, setOpen] = useState(false);
  const expandable = Boolean(input || output);
  const status = tool.status ?? t("acpToolPending");

  return <div className="group/tool text-xs" data-testid="workspace-tool-event">
    <button
      aria-expanded={expandable ? open : undefined}
      className={`flex w-full items-center gap-2 py-1.5 text-left text-muted-foreground outline-none ${expandable ? "cursor-pointer" : "cursor-default"}`}
      onClick={() => {
        if (expandable) setOpen((current) => !current);
      }}
      type="button"
    >
      <WrenchIcon className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate font-medium transition-colors duration-[var(--motion-duration-fast)] group-hover/tool:text-foreground group-focus-within/tool:text-foreground">{tool.title}</span>
      <span className={tool.status === "failed" ? "shrink-0 text-destructive" : "shrink-0"}>{status}</span>
      {expandable ? <ChevronRightIcon className={`size-3.5 shrink-0 opacity-0 transition-[transform,opacity] duration-[var(--motion-duration-base)] ease-[var(--motion-ease-standard)] group-hover/tool:opacity-100 group-focus-within/tool:opacity-100 motion-reduce:transition-none ${open ? "rotate-90" : ""}`} /> : null}
    </button>
    {expandable ? <div
      aria-hidden={!open}
      className={`grid transition-[grid-template-rows,opacity] duration-[var(--motion-duration-panel)] ease-[var(--motion-ease-emphasized)] motion-reduce:transition-none ${open ? "grid-rows-[1fr] opacity-100" : "pointer-events-none grid-rows-[0fr] opacity-0"}`}
      data-testid="workspace-tool-details"
    >
      <div className="min-h-0 overflow-hidden">
        <div className="ml-1.5 mt-1 space-y-3 border-l border-border/80 py-1 pl-4">
          {input ? <ToolPayload label={t("acpToolInput")} presentation="workspace" value={input} /> : null}
          {output ? <ToolPayload label={t("acpToolOutput")} presentation="workspace" value={output} /> : null}
        </div>
      </div>
    </div> : null}
  </div>;
}

function ToolPayload({ label, presentation = "inspector", value }: {
  label: string;
  presentation?: AcpConversationPresentation;
  value: string;
}) {
  return <div className="space-y-1"><div className="font-medium text-muted-foreground">{label}</div><pre className={`max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5 ${presentation === "workspace" ? "" : "rounded-md bg-muted p-2"}`}>{value}</pre></div>;
}
