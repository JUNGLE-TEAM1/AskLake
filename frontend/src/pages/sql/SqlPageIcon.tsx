import { Table2, type LucideProps } from "lucide-react";

export const SQL_PAGE_SECTION_MARKER_CLASS_NAME = "size-5 rounded-none bg-transparent shadow-none";

export function SqlSectionMarker() {
  return <span aria-hidden="true" className="size-2.5 rounded-full bg-sky-400 ring-4 ring-sky-50" />;
}

/** SQL 화면에서 사용하는 공통 테이블 아이콘. 호출부의 기존 size/className을 그대로 전달한다. */
export function SqlPageIcon(props: LucideProps) {
  return <Table2 {...props} />;
}
