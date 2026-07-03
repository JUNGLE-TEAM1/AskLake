import { Info } from "lucide-react";
import { CreationSummaryPanel } from "../components/creation/CreationFlow";
import { InfoBox, PageTitle } from "../components/common";
import type { FlowId } from "../types";

type PlaceholderFlow = Extract<FlowId, "ai" | "admin">;

export function ModulePlaceholderPage({
  description,
  flow,
  onRequirements,
  onPrimary,
  onStatusRecord,
  owner,
  title,
}: {
  description: string;
  flow: PlaceholderFlow;
  onRequirements: () => void;
  onPrimary: () => void;
  onStatusRecord: () => void;
  owner: string;
  title: string;
}) {
  const roadmapByFlow: Record<PlaceholderFlow, Array<[string, string]>> = {
    ai: [
      ["입력", "RAG 대상 Lake 데이터셋"],
      ["작업", "Chunk Rule, Embedding, Vector DB"],
      ["연결 액션", "권한 기반 AI 질의"],
    ],
    admin: [
      ["대상", "사용자, 그룹, API Client"],
      ["작업", "권한 정책, 감사 로그 조회"],
      ["연결 액션", "운영 추적 및 접근 제어"],
    ],
  };

  return (
    <div className="content-grid">
      <div className="content-main">
        <PageTitle title={title} description={description} />
        <div className="review-card-grid compact-cards">
          {roadmapByFlow[flow].map(([label, value]) => (
            <article className="review-mini-card" key={label}>
              <strong>{label}</strong>
              <span>{value}</span>
            </article>
          ))}
        </div>
        <section className="panel">
          <div className="panel-header">
            <Info size={18} />
            <h2>통합 상태</h2>
            <span className="panel-note">담당: {owner}</span>
          </div>
          <InfoBox title="다음 통합 대상" body="사이드바 연결과 정보 구조는 잡아두었고, 해당 팀 파트 화면을 붙일 때 이 영역을 실제 구현으로 교체하면 됩니다." />
          <div className="form-actions inline">
            <button className="secondary-button" type="button" onClick={onRequirements}>요구사항 확인</button>
            <button className="primary-button" type="button" onClick={onPrimary}>통합 예정 액션 기록</button>
          </div>
        </section>
      </div>
      <CreationSummaryPanel
        flow={flow}
        title="섹션 요약"
        hint="현재는 정보 구조와 연결 지점만 잡아둔 상태입니다."
        prevLabel="요구사항 확인"
        saveLabel="상태 기록"
        nextLabel="통합 예정"
        onNext={onPrimary}
        onPrev={onRequirements}
        onSave={onStatusRecord}
      />
    </div>
  );
}
