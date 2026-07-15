import type React from "react";
import { FolderSearch, Search, Table2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type SourceExplorerFilterOption = {
  label: string;
  value: string;
};

type SourceExplorerWorkbenchProps = {
  explorer: React.ReactNode;
  explorerMeta?: React.ReactNode;
  explorerTitle: React.ReactNode;
  filterOptions: SourceExplorerFilterOption[];
  filterValue: string;
  onFilterChange: (value: string) => void;
  onPathChange: (value: string) => void;
  onPathSubmit?: () => void;
  onQueryChange: (value: string) => void;
  pathPlaceholder?: string;
  pathValue: string;
  preview: React.ReactNode;
  previewIcon?: React.ReactNode;
  previewMeta?: React.ReactNode;
  previewTitle: React.ReactNode;
  queryPlaceholder: string;
  queryValue: string;
  showPathSearch?: boolean;
};

export function SourceExplorerWorkbench({
  explorer,
  explorerMeta,
  explorerTitle,
  filterOptions,
  filterValue,
  onFilterChange,
  onPathChange,
  onPathSubmit,
  onQueryChange,
  pathPlaceholder = "경로 또는 프리픽스 입력",
  pathValue,
  preview,
  previewIcon,
  previewMeta,
  previewTitle,
  queryPlaceholder,
  queryValue,
  showPathSearch = false,
}: SourceExplorerWorkbenchProps) {
  return (
    <div className="source-explorer-workbench">
      <Panel className="source-explorer-panel source-explorer-assets-panel border-2 border-blue-300 shadow-[0_6px_18px_rgb(37_99_235_/_7%)]">
        <PanelHeader
          className="min-h-14 border-blue-200 bg-blue-50 px-4 py-3"
          icon={<FolderSearch />}
          iconClassName="size-9 rounded-md bg-blue-100 [&_svg]:size-[18px]"
          meta={explorerMeta}
          title={explorerTitle}
        />
        <div className="source-explorer-panel-body">
          {showPathSearch ? (
            <form className="source-explorer-path-row" onSubmit={(event) => { event.preventDefault(); onPathSubmit?.(); }}>
              <InputGroup>
                <InputGroupAddon><FolderSearch className="size-4" aria-hidden="true" /></InputGroupAddon>
                <InputGroupInput
                  aria-label="경로로 이동"
                  placeholder={pathPlaceholder}
                  value={pathValue}
                  onChange={(event) => onPathChange(event.target.value)}
                />
              </InputGroup>
              <Button type="submit" variant="outline">경로 이동</Button>
            </form>
          ) : null}
          <div className="source-explorer-filter-row">
            <InputGroup>
              <InputGroupAddon><Search className="size-4" aria-hidden="true" /></InputGroupAddon>
              <InputGroupInput
                aria-label={queryPlaceholder}
                placeholder={queryPlaceholder}
                type="search"
                value={queryValue}
                onChange={(event) => onQueryChange(event.target.value)}
              />
            </InputGroup>
            {filterOptions.length > 1 ? (
              <Select value={filterValue} onValueChange={onFilterChange}>
                <SelectTrigger aria-label="탐색 결과 필터" className="source-explorer-filter-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {filterOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                </SelectContent>
              </Select>
            ) : null}
          </div>
          <div className="source-explorer-tree-slot">{explorer}</div>
        </div>
      </Panel>

      <Panel className="source-explorer-panel source-explorer-preview-panel border-2 border-blue-300 shadow-[0_6px_18px_rgb(37_99_235_/_7%)]">
        <PanelHeader
          className="min-h-14 border-blue-200 bg-blue-50 px-4 py-3"
          icon={previewIcon ?? <Table2 />}
          iconClassName="size-9 rounded-md bg-blue-100 [&_svg]:size-[18px]"
          meta={previewMeta}
          title={previewTitle}
        />
        <div className="source-explorer-preview-slot">{preview}</div>
      </Panel>
    </div>
  );
}
