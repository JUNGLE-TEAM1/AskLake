import type { RagProfile } from "../../services/semanticApi";

type RagServingStatusProps = {
  profile?: RagProfile;
};

export function RagServingStatus({ profile }: RagServingStatusProps) {
  if (!profile) return null;
  return (
    <div className="semantic-real-rag-serving-status" aria-label="RAG 빌드 및 서빙 상태">
      <span>빌드: <strong>{profile.buildStatus ?? profile.indexStatus}</strong></span>
      <span>서빙: <strong>{profile.servingStatus ?? "not_serving"}</strong></span>
      {profile.servingStatus === "serving" && <span className="semantic-real-rag-serving-live">현재 검색 가능</span>}
    </div>
  );
}
