import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, ChevronRight, Filter, Search, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  const activeFilterCount = (ownerFilter === "all" ? 0 : 1) + selectedTags.length;

  return (
    <section className="dashboard-list-toolbar dashboard-panel-card">
      <div className="dashboard-panel-header">
        <span className="dashboard-panel-icon">
          <SlidersHorizontal size={16} />
        </span>
        <div className="dashboard-panel-heading">
          <h2>검색 및 필터</h2>
          <p>이름, 소유자, 태그, 정렬 기준으로 대시보드 목록을 좁혀 봅니다.</p>
        </div>
        <span className="dashboard-panel-state">{activeFilterCount ? `${activeFilterCount} active` : "필터"}</span>
      </div>
      <div className="dashboard-list-toolbar-body">
        <div className="dashboard-list-search">
          <Search size={16} />
          <Input
            className="dashboard-list-search-input"
            aria-label="대시보드 검색"
            type="search"
            placeholder="대시보드 검색..."
            value={searchQuery}
            onChange={(event) => onSearchQueryChange(event.target.value)}
          />
        </div>
        <div className="dashboard-toolbar-actions">
          <div className="dashboard-toolbar-menu">
            <Button className="dashboard-filter-button" type="button" aria-expanded={openControl === "owner"} aria-haspopup="menu" onClick={() => onToggleControl("owner")} size="sm" variant="outline">
              <Filter size={22} />
              <span>{ownerFilter === "all" ? "모든 소유자" : ownerFilter}</span>
              <ChevronDown size={18} />
            </Button>
            {openControl === "owner" && (
              <div className="dashboard-list-menu" role="menu">
                <Button className={ownerFilter === "all" ? "dashboard-menu-option active" : "dashboard-menu-option"} type="button" role="menuitem" onClick={() => onSelectOwner("all")} size="sm" variant="ghost">모든 소유자</Button>
                {owners.map((owner) => (
                  <Button className={ownerFilter === owner ? "dashboard-menu-option active" : "dashboard-menu-option"} key={owner} type="button" role="menuitem" onClick={() => onSelectOwner(owner)} size="sm" variant="ghost">{owner}</Button>
                ))}
              </div>
            )}
          </div>
          <div className="dashboard-toolbar-menu">
            <Button className="dashboard-filter-button" type="button" aria-expanded={openControl === "tag"} aria-haspopup="menu" onClick={() => onToggleControl("tag")} size="sm" variant="outline">
              <span>{selectedTags.length ? `태그 ${selectedTags.length}개` : "태그 필터"}</span>
              <ChevronRight size={18} />
            </Button>
            {openControl === "tag" && (
              <div className="dashboard-list-menu" role="menu">
                <Button className="dashboard-menu-option" type="button" role="menuitem" onClick={onClearTags} size="sm" variant="ghost">전체 태그</Button>
                {tags.map((tag) => (
                  <label className="dashboard-menu-option checkbox" key={tag}>
                    <input type="checkbox" checked={selectedTags.includes(tag)} onChange={() => onToggleTag(tag)} />
                    <span>{tag}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
          <span className="dashboard-toolbar-divider" aria-hidden="true" />
          <div className="dashboard-toolbar-menu">
            <Button className="dashboard-sort-button" type="button" aria-label={`정렬 기준: ${activeSortLabel}`} aria-expanded={openControl === "sort"} aria-haspopup="menu" title={activeSortLabel} onClick={() => onToggleControl("sort")} size="icon" variant="outline">
              <ArrowUpDown size={24} />
            </Button>
            {openControl === "sort" && (
              <div className="dashboard-list-menu sort" role="menu">
                {dashboardSortOptions.map((option) => (
                  <Button className={sortOption === option.id ? "dashboard-menu-option active" : "dashboard-menu-option"} key={option.id} type="button" role="menuitem" aria-label={option.ariaLabel} onClick={() => onSelectSort(option.id)} size="sm" variant="ghost">
                    <span>{option.label}</span>
                    {option.direction === "asc" ? <ArrowUp size={16} /> : <ArrowDown size={16} />}
                  </Button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
