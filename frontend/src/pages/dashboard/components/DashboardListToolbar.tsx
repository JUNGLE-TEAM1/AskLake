import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, ChevronRight, Filter, Search, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FilterToolbar, FilterToolbarActions, FilterToolbarDivider, FilterToolbarInput, FilterToolbarMenu, FilterToolbarSearch } from "@/components/ui/filter-toolbar";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { dashboardSortOptions, getDashboardSortLabel } from "../dashboardListUtils";
import type { DashboardListControl, DashboardSortOption } from "../dashboardListUtils";

export function DashboardListToolbar({
  onClearTags,
  onSearchQueryChange,
  onSelectOwner,
  onSelectSort,
  onToggleControl,
  onToggleTag,
  openControl,
  ownerFilter,
  owners,
  searchQuery,
  selectedTags,
  sortOption,
  tags,
}: {
  onClearTags: () => void;
  onSearchQueryChange: (value: string) => void;
  onSelectOwner: (owner: string) => void;
  onSelectSort: (sortOption: DashboardSortOption) => void;
  onToggleControl: (control: DashboardListControl) => void;
  onToggleTag: (tag: string) => void;
  openControl: DashboardListControl | null;
  ownerFilter: string;
  owners: string[];
  searchQuery: string;
  selectedTags: string[];
  sortOption: DashboardSortOption;
  tags: string[];
}) {
  const activeSortLabel = getDashboardSortLabel(sortOption);
  const setControlOpen = (control: DashboardListControl, open: boolean) => {
    if ((openControl === control) !== open) onToggleControl(control);
  };

  return (
    <Panel className="dashboard-list-toolbar" overflow="visible">
      <PanelHeader
        icon={<SlidersHorizontal size={16} />}
        title="검색 및 필터"
      />
      <FilterToolbar layout="actions">
        <FilterToolbarSearch icon={<Search size={16} />}>
          <FilterToolbarInput
            aria-label="대시보드 검색"
            placeholder="대시보드 검색..."
            type="search"
            value={searchQuery}
            onChange={(event) => onSearchQueryChange(event.target.value)}
          />
        </FilterToolbarSearch>
        <FilterToolbarActions>
          <FilterToolbarMenu>
            <DropdownMenu open={openControl === "owner"} onOpenChange={(open) => setControlOpen("owner", open)}>
              <DropdownMenuTrigger asChild>
                <Button className="dashboard-filter-button" type="button" size="sm" variant="outline">
                  <Filter size={22} />
                  <span>{ownerFilter === "all" ? "모든 소유자" : ownerFilter}</span>
                  <ChevronDown size={18} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="dashboard-list-menu">
                <DropdownMenuLabel>소유자</DropdownMenuLabel>
                <DropdownMenuItem className={ownerFilter === "all" ? "dashboard-menu-option active" : "dashboard-menu-option"} onSelect={() => onSelectOwner("all")}>
                  모든 소유자
                </DropdownMenuItem>
                {owners.map((owner) => (
                  <DropdownMenuItem
                    className={ownerFilter === owner ? "dashboard-menu-option active" : "dashboard-menu-option"}
                    key={owner}
                    onSelect={() => onSelectOwner(owner)}
                  >
                    {owner}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </FilterToolbarMenu>
          <FilterToolbarMenu>
            <DropdownMenu open={openControl === "tag"} onOpenChange={(open) => setControlOpen("tag", open)}>
              <DropdownMenuTrigger asChild>
                <Button className="dashboard-filter-button" type="button" size="sm" variant="outline">
                  <span>{selectedTags.length ? `태그 ${selectedTags.length}개` : "태그 필터"}</span>
                  <ChevronRight size={18} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="dashboard-list-menu">
                <DropdownMenuLabel>태그</DropdownMenuLabel>
                <DropdownMenuItem className="dashboard-menu-option" onSelect={onClearTags}>
                  전체 태그
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {tags.map((tag) => (
                  <DropdownMenuCheckboxItem
                    checked={selectedTags.includes(tag)}
                    className="dashboard-menu-option checkbox"
                    key={tag}
                    onCheckedChange={() => onToggleTag(tag)}
                    onSelect={(event) => event.preventDefault()}
                  >
                    {tag}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </FilterToolbarMenu>
          <FilterToolbarDivider aria-hidden="true" />
          <FilterToolbarMenu>
            <DropdownMenu open={openControl === "sort"} onOpenChange={(open) => setControlOpen("sort", open)}>
              <DropdownMenuTrigger asChild>
                <Button className="dashboard-sort-button" type="button" aria-label={`정렬 기준: ${activeSortLabel}`} title={activeSortLabel} size="icon" variant="outline">
                  <ArrowUpDown size={24} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="dashboard-list-menu sort">
                <DropdownMenuLabel>정렬 기준</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={sortOption} onValueChange={(value) => onSelectSort(value as DashboardSortOption)}>
                  {dashboardSortOptions.map((option) => (
                    <DropdownMenuRadioItem className="dashboard-menu-option" key={option.id} value={option.id} aria-label={option.ariaLabel}>
                      <span>{option.label}</span>
                      {option.direction === "asc" ? <ArrowUp size={16} /> : <ArrowDown size={16} />}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </FilterToolbarMenu>
        </FilterToolbarActions>
      </FilterToolbar>
    </Panel>
  );
}
