import { Table2, type LucideProps } from "lucide-react";

export const SQL_PAGE_PANEL_ICON_CLASS_NAME = "rounded-xl border border-slate-200 bg-white text-blue-700 shadow-sm";

/** SQL 화면에서 사용하는 공통 테이블 아이콘. 호출부의 기존 size/className을 그대로 전달한다. */
export function SqlPageIcon(props: LucideProps) {
  return <Table2 {...props} />;
}
