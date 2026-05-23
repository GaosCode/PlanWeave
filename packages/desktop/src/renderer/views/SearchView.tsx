import type { Dispatch, SetStateAction } from "react";
import type { DesktopSearchResult } from "@planweave/runtime";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SearchResultList } from "../components/SearchResultList";
import type { createTranslator } from "../i18n";

type SearchViewProps = {
  handleSearchResultOpen: (result: DesktopSearchResult) => Promise<void>;
  searchQuery: string;
  searchResults: DesktopSearchResult[];
  setSearchQuery: Dispatch<SetStateAction<string>>;
  t: ReturnType<typeof createTranslator>;
};

export function SearchView({ handleSearchResultOpen, searchQuery, searchResults, setSearchQuery, t }: SearchViewProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="text-sm font-medium">{t("query")}</div>
      <Input data-testid="search-query-input" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} />
      <ScrollArea className="h-[520px]">
        <SearchResultList results={searchResults} targetMissingLabel={t("searchTargetMissing")} onOpenResult={handleSearchResultOpen} />
      </ScrollArea>
    </div>
  );
}
