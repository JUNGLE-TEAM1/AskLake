import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, ChevronRight, Filter, Search } from "lucide-react";
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

  return (
    <section className="dashboard-list-toolbar">
      <div className="dashboard-list-search">
        <Search size={16} />
        <input
          aria-label="대시보드 검색"
          type="search"
          placeholder="대시보드 검색..."
          value={searchQuery}
          onChange={(event) => onSearchQueryChange(event.target.value)}
        />
      </div>
      <div className="dashboard-toolbar-actions">
        <div className="dashboard-toolbar-menu">
          <button className="dashboard-filter-button" type="button" aria-expanded={openControl === "owner"} aria-haspopup="menu" onClick={() => onToggleControl("owner")}>
            <Filter size={22} />
            <span>{ownerFilter === "all" ? "모든 소유자" : ownerFilter}</span>
            <ChevronDown size={18} />
          </button>
          {openControl === "owner" && (
            <div className="dashboard-list-menu" role="menu">
              <button className={ownerFilter === "all" ? "dashboard-menu-option active" : "dashboard-menu-option"} type="button" role="menuitem" onClick={() => onSelectOwner("all")}>모든 소유자</button>
              {owners.map((owner) => (
                <button className={ownerFilter === owner ? "dashboard-menu-option active" : "dashboard-menu-option"} key={owner} type="button" role="menuitem" onClick={() => onSelectOwner(owner)}>{owner}</button>
              ))}
            </div>
          )}
        </div>
        <div className="dashboard-toolbar-menu">
          <button className="dashboard-filter-button" type="button" aria-expanded={openControl === "tag"} aria-haspopup="menu" onClick={() => onToggleControl("tag")}>
            <span>{selectedTags.length ? `태그 ${selectedTags.length}개` : "태그 필터"}</span>
            <ChevronRight size={18} />
          </button>
          {openControl === "tag" && (
            <div className="dashboard-list-menu" role="menu">
              <button className="dashboard-menu-option" type="button" role="menuitem" onClick={onClearTags}>전체 태그</button>
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
          <button className="dashboard-sort-button" type="button" aria-label={`정렬 기준: ${activeSortLabel}`} aria-expanded={openControl === "sort"} aria-haspopup="menu" title={activeSortLabel} onClick={() => onToggleControl("sort")}>
            <ArrowUpDown size={24} />
          </button>
          {openControl === "sort" && (
            <div className="dashboard-list-menu sort" role="menu">
              {dashboardSortOptions.map((option) => (
                <button className={sortOption === option.id ? "dashboard-menu-option active" : "dashboard-menu-option"} key={option.id} type="button" role="menuitem" aria-label={option.ariaLabel} onClick={() => onSelectSort(option.id)}>
                  <span>{option.label}</span>
                  {option.direction === "asc" ? <ArrowUp size={16} /> : <ArrowDown size={16} />}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
