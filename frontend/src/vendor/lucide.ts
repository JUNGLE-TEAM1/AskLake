import type { ForwardRefExoticComponent, RefAttributes, SVGProps } from "react";

export type LucideProps = Omit<SVGProps<SVGSVGElement>, "ref"> & {
  absoluteStrokeWidth?: boolean;
  color?: string;
  size?: number | string;
  strokeWidth?: number | string;
};

export type LucideIcon = ForwardRefExoticComponent<
  LucideProps & RefAttributes<SVGSVGElement>
>;

export { default as Activity } from "lucide-react/dist/esm/icons/activity.mjs";
export { default as ArrowDown } from "lucide-react/dist/esm/icons/arrow-down.mjs";
export { default as ArrowUp } from "lucide-react/dist/esm/icons/arrow-up.mjs";
export { default as ArrowUpDown } from "lucide-react/dist/esm/icons/arrow-up-down.mjs";
export { default as BarChart3 } from "lucide-react/dist/esm/icons/chart-column.mjs";
export { default as BookOpen } from "lucide-react/dist/esm/icons/book-open.mjs";
export { default as Bot } from "lucide-react/dist/esm/icons/bot.mjs";
export { default as Calendar } from "lucide-react/dist/esm/icons/calendar.mjs";
export { default as Check } from "lucide-react/dist/esm/icons/check.mjs";
export { default as ChevronDown } from "lucide-react/dist/esm/icons/chevron-down.mjs";
export { default as ChevronRight } from "lucide-react/dist/esm/icons/chevron-right.mjs";
export { default as ChevronUp } from "lucide-react/dist/esm/icons/chevron-up.mjs";
export { default as CircleHelp } from "lucide-react/dist/esm/icons/circle-help.mjs";
export { default as CircleUser } from "lucide-react/dist/esm/icons/circle-user.mjs";
export { default as Clock3 } from "lucide-react/dist/esm/icons/clock-3.mjs";
export { default as Database } from "lucide-react/dist/esm/icons/database.mjs";
export { default as Download } from "lucide-react/dist/esm/icons/download.mjs";
export { default as ExternalLink } from "lucide-react/dist/esm/icons/external-link.mjs";
export { default as Eye } from "lucide-react/dist/esm/icons/eye.mjs";
export { default as FileText } from "lucide-react/dist/esm/icons/file-text.mjs";
export { default as Filter } from "lucide-react/dist/esm/icons/filter.mjs";
export { default as HardDrive } from "lucide-react/dist/esm/icons/hard-drive.mjs";
export { default as History } from "lucide-react/dist/esm/icons/history.mjs";
export { default as Info } from "lucide-react/dist/esm/icons/info.mjs";
export { default as LayoutGrid } from "lucide-react/dist/esm/icons/layout-grid.mjs";
export { default as LogOut } from "lucide-react/dist/esm/icons/log-out.mjs";
export { default as Maximize2 } from "lucide-react/dist/esm/icons/maximize-2.mjs";
export { default as Minus } from "lucide-react/dist/esm/icons/minus.mjs";
export { default as Pencil } from "lucide-react/dist/esm/icons/pencil.mjs";
export { default as Pin } from "lucide-react/dist/esm/icons/pin.mjs";
export { default as PlayCircle } from "lucide-react/dist/esm/icons/play-circle.mjs";
export { default as Plus } from "lucide-react/dist/esm/icons/plus.mjs";
export { default as RefreshCw } from "lucide-react/dist/esm/icons/refresh-cw.mjs";
export { default as Repeat2 } from "lucide-react/dist/esm/icons/repeat-2.mjs";
export { default as RotateCcw } from "lucide-react/dist/esm/icons/rotate-ccw.mjs";
export { default as Save } from "lucide-react/dist/esm/icons/save.mjs";
export { default as Search } from "lucide-react/dist/esm/icons/search.mjs";
export { default as Send } from "lucide-react/dist/esm/icons/send.mjs";
export { default as Settings } from "lucide-react/dist/esm/icons/settings.mjs";
export { default as Share2 } from "lucide-react/dist/esm/icons/share-2.mjs";
export { default as ShieldCheck } from "lucide-react/dist/esm/icons/shield-check.mjs";
export { default as SlidersHorizontal } from "lucide-react/dist/esm/icons/sliders-horizontal.mjs";
export { default as Star } from "lucide-react/dist/esm/icons/star.mjs";
export { default as Table2 } from "lucide-react/dist/esm/icons/table-2.mjs";
export { default as TerminalSquare } from "lucide-react/dist/esm/icons/terminal-square.mjs";
export { default as Trash2 } from "lucide-react/dist/esm/icons/trash-2.mjs";
export { default as Workflow } from "lucide-react/dist/esm/icons/workflow.mjs";
export { default as X } from "lucide-react/dist/esm/icons/x.mjs";
