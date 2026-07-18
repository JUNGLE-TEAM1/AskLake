import { FileText } from "lucide-react";

import { EmptyState } from "@/components/ui/empty-state";

type SourceRawSamplePreviewProps = {
  ariaLabel?: string;
  lines: string[];
};

export function SourceRawSamplePreview({ ariaLabel = "원본 로그 샘플", lines }: SourceRawSamplePreviewProps) {
  if (lines.length === 0) {
    return (
      <EmptyState
        className="source-preview-empty-state"
        description=".log/.txt 파일 또는 Kafka raw text 토픽을 선택하면 원문 일부를 확인할 수 있습니다."
        icon={<FileText />}
        size="sm"
        title="표시할 원본 샘플이 없습니다."
        variant="plain"
      />
    );
  }

  return (
    <div className="source-raw-sample-preview">
      <textarea
        aria-label={ariaLabel}
        className="source-raw-sample-textarea"
        readOnly
        spellCheck={false}
        value={lines.join("\n")}
      />
    </div>
  );
}
