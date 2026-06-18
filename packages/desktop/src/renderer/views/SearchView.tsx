import type { Dispatch, SetStateAction } from "react";
import type { DesktopProjectSummary, DesktopSearchResult, DesktopSearchResultKind } from "@planweave-ai/runtime";
import { FolderOpenIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SearchResultList } from "../components/SearchResultList";
import type { DesktopSearchCanvasScope } from "../hooks/useDesktopSearch";
import type { createTranslator } from "../i18n";

type SearchViewProps = {
  handleOpenProject: () => Promise<void>;
  handleSearchResultOpen: (result: DesktopSearchResult) => Promise<void>;
  searchCanvasScope: DesktopSearchCanvasScope;
  searchQuery: string;
  searchResultKinds: DesktopSearchResultKind[];
  searchResults: DesktopSearchResult[];
  selectedCanvasId: string | null;
  selectedProject: DesktopProjectSummary | null;
  selectedSearchResultKinds: DesktopSearchResultKind[];
  setSearchCanvasScope: Dispatch<SetStateAction<DesktopSearchCanvasScope>>;
  setSearchQuery: Dispatch<SetStateAction<string>>;
  setSearchResultKindEnabled: (kind: DesktopSearchResultKind, enabled: boolean) => void;
  t: ReturnType<typeof createTranslator>;
};

function searchKindLabel(kind: DesktopSearchResultKind, t: ReturnType<typeof createTranslator>): string {
  switch (kind) {
    case "task":
      return t("searchKindTask");
    case "block":
      return t("searchKindBlock");
    case "prompt":
      return t("searchKindPrompt");
    case "run_record":
      return t("searchKindRunRecord");
    case "review_attempt":
      return t("searchKindReviewAttempt");
    case "feedback":
      return t("searchKindFeedback");
  }
  const exhaustiveKind: never = kind;
  return exhaustiveKind;
}

export function SearchView({
  handleOpenProject,
  handleSearchResultOpen,
  searchCanvasScope,
  searchQuery,
  searchResultKinds,
  searchResults,
  selectedCanvasId,
  selectedProject,
  selectedSearchResultKinds,
  setSearchCanvasScope,
  setSearchQuery,
  setSearchResultKindEnabled,
  t
}: SearchViewProps) {
  const selectedKinds = new Set(selectedSearchResultKinds);
  const hasProject = Boolean(selectedProject);
  const hasQuery = Boolean(searchQuery.trim());
  return (
    <section className="flex h-full min-h-0 flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-normal text-text-strong">{t("search")}</h1>
        <p className="mt-1 text-sm text-text-muted">{t("searchPlaceholder")}</p>
      </div>
      <div className="flex flex-col gap-4 rounded-md border border-border/80 bg-surface-raised p-4 shadow-sm">
        <div className="flex flex-col gap-2">
          <div className="text-sm font-medium text-text-strong">{t("query")}</div>
          <Input data-testid="search-query-input" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} />
        </div>
        <div className="flex flex-col gap-2">
          <div className="text-xs font-medium text-text-muted">{t("searchResultKinds")}</div>
          <div className="flex flex-wrap gap-2">
            {searchResultKinds.map((kind) => {
              const selected = selectedKinds.has(kind);
              return (
                <Button
                  aria-pressed={selected}
                  data-testid={`search-kind-${kind}`}
                  key={kind}
                  size="sm"
                  variant={selected ? "secondary" : "outline"}
                  onClick={() => setSearchResultKindEnabled(kind, !selected)}
                >
                  {searchKindLabel(kind, t)}
                </Button>
              );
            })}
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <div className="text-xs font-medium text-text-muted">{t("searchCanvasScope")}</div>
          <div className="flex flex-wrap gap-2">
            <Button
              aria-pressed={searchCanvasScope === "all"}
              data-testid="search-scope-all"
              size="sm"
              variant={searchCanvasScope === "all" ? "secondary" : "outline"}
              onClick={() => setSearchCanvasScope("all")}
            >
              {t("searchScopeAllCanvases")}
            </Button>
            <Button
              aria-pressed={searchCanvasScope === "current"}
              data-testid="search-scope-current"
              disabled={!selectedCanvasId}
              size="sm"
              variant={searchCanvasScope === "current" ? "secondary" : "outline"}
              onClick={() => setSearchCanvasScope("current")}
            >
              {t("searchScopeCurrentCanvas")}
            </Button>
          </div>
          {!selectedCanvasId ? <div className="text-xs text-text-muted">{t("searchNoCanvasHint")}</div> : null}
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {!hasProject ? (
          <div className="flex flex-col gap-3 rounded-md border border-border/80 bg-surface-raised p-4 text-text shadow-sm">
            <div className="text-sm font-medium text-text-strong">{t("searchNoProjectTitle")}</div>
            <div className="text-sm text-text-muted">{t("searchNoProjectDescription")}</div>
            <Button className="w-fit" variant="outline" onClick={() => void handleOpenProject()}>
              <FolderOpenIcon data-icon="inline-start" />
              {t("openProject")}
            </Button>
          </div>
        ) : !hasQuery ? (
          <div className="rounded-md border border-border/80 bg-surface-muted/70 p-4 text-sm text-text-muted">{t("searchEmptyHint")}</div>
        ) : (
          <SearchResultList results={searchResults} targetMissingLabel={t("searchTargetMissing")} onOpenResult={handleSearchResultOpen} />
        )}
      </ScrollArea>
    </section>
  );
}
