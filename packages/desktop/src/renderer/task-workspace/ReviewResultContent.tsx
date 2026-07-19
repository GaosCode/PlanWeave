import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { SafeMarkdown } from "../inspector/SafeMarkdown";

const findingPattern = /^(?:\[(P[0-3])\]\s+|(P[0-3])\s*(?:—|–|-|:|：)\s*)([\s\S]+)$/i;
const verificationPattern = /^(已运行|验证|verification|checks?|tests?)\s*[：:]\s*([\s\S]+)$/i;

const priorityClasses: Record<string, string> = {
  P0: "border-red-500/35 bg-red-500/5 text-red-700 dark:text-red-300",
  P1: "border-orange-500/35 bg-orange-500/5 text-orange-700 dark:text-orange-300",
  P2: "border-amber-500/35 bg-amber-500/5 text-amber-700 dark:text-amber-300",
  P3: "border-sky-500/35 bg-sky-500/5 text-sky-700 dark:text-sky-300"
};

type ReviewContentSection =
  | { body: string; kind: "finding"; priority: string }
  | { body: string; kind: "verification"; label: string }
  | { body: string; kind: "prose" };

export function parseReviewContent(content: string): ReviewContentSection[] {
  return content
    .trim()
    .split(/\n\s*\n/)
    .filter((paragraph) => paragraph.trim().length > 0)
    .map((paragraph): ReviewContentSection => {
      const normalized = paragraph.trim();
      const finding = findingPattern.exec(normalized);
      const priority = finding?.[1] ?? finding?.[2];
      if (priority && finding?.[3]) {
        return { body: finding[3].trim(), kind: "finding", priority: priority.toUpperCase() };
      }
      const verification = verificationPattern.exec(normalized);
      if (verification?.[1] && verification[2]) {
        return {
          body: verification[2].trim(),
          kind: "verification",
          label: verification[1]
        };
      }
      return { body: normalized, kind: "prose" };
    });
}

export function ReviewResultContent({ content }: { content: string }) {
  const sections = parseReviewContent(content);
  const sectionOccurrences = new Map<string, number>();
  return (
    <div className="space-y-3 text-[13px] leading-6 text-text">
      {sections.map((section) => {
        const sectionIdentity = `${section.kind}:${section.body}`;
        const sectionOccurrence = sectionOccurrences.get(sectionIdentity) ?? 0;
        sectionOccurrences.set(sectionIdentity, sectionOccurrence + 1);
        const sectionKey = `${sectionIdentity}:${sectionOccurrence}`;
        if (section.kind === "finding") {
          return (
            <section
              className={cn(
                "grid grid-cols-[auto_minmax(0,1fr)] gap-3 rounded-lg border px-3.5 py-3",
                priorityClasses[section.priority]
              )}
              data-review-priority={section.priority}
              key={`${sectionKey}:${section.priority}`}
            >
              <Badge className="mt-0.5 h-5 px-1.5 text-[10px]" variant="outline">
                {section.priority}
              </Badge>
              <div className="min-w-0 text-text">
                <SafeMarkdown markdown={section.body} />
              </div>
            </section>
          );
        }
        if (section.kind === "verification") {
          return (
            <section
              className="rounded-lg border border-border/70 bg-surface-muted/35 px-3.5 py-3"
              data-review-section="verification"
              key={`${sectionKey}:${section.label}`}
            >
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                {section.label}
              </div>
              <SafeMarkdown markdown={section.body} />
            </section>
          );
        }
        return (
          <div className="px-0.5 text-text-muted" key={sectionKey}>
            <SafeMarkdown markdown={section.body} />
          </div>
        );
      })}
    </div>
  );
}
