import {
  AlertTriangle,
  Bot,
  Check,
  ChevronRight,
  CircleUser,
  Database,
  CheckCircle2,
  FileText,
  Hash,
  Boxes,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  Workflow,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AuditResult, CatalogDataset } from "../../types";
import {
  cloneSemanticModels,
  cloneSemanticRagProfiles,
  createSemanticPermissionGrant,
  type RagClassification,
  type RagColumnRole,
  type RagDatasetProfile,
  type RagEmbeddingStatus,
  type RagIndexStatus,
  type SemanticLayerModel,
  type SemanticMetric,
  type SemanticPermissionAction,
} from "../../data/semanticLayerMock";
import askLakeNessiIconUrl from "../../assets/asklake-nessi-icon.png";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Panel, PanelHeader } from "../../components/ui/panel";
import { Textarea } from "../../components/ui/textarea";

type SemanticTab = "summary" | "metrics" | "dimensions" | "datasets" | "vocabulary" | "access";
const accessActions: SemanticPermissionAction[] = ["view", "query", "manage", "publish", "share"];
const accessActionLabels: Record<SemanticPermissionAction, string> = { view: "보기", query: "조회", run: "실행", manage: "관리", delete: "삭제", publish: "Publish", share: "공유" };

const classificationMeta: Record<RagClassification, { label: string; tone: "success" | "muted" | "warning" | "default"; icon: typeof FileText }> = {
  analytics_only: { label: "분석 전용", tone: "muted", icon: Database },
  review: { label: "고객 리뷰", tone: "success", icon: FileText },
  support_conversation: { label: "상담 대화", tone: "default", icon: FileText },
  incident_report: { label: "장애 보고", tone: "warning", icon: AlertTriangle },
  business_document: { label: "업무 문서", tone: "default", icon: FileText },
  mixed: { label: "혼합 데이터", tone: "warning", icon: Boxes },
  unknown: { label: "판단 필요", tone: "warning", icon: Search },
};

const indexMeta: Record<RagIndexStatus, { label: string; tone: "success" | "muted" | "warning" | "default" }> = {
  ready: { label: "검색 가능", tone: "success" },
  indexing: { label: "색인 중", tone: "default" },
  not_indexed: { label: "색인 안 함", tone: "muted" },
  failed: { label: "색인 실패", tone: "warning" },
};

const embeddingMeta: Record<RagEmbeddingStatus, { label: string; tone: "success" | "muted" | "warning" | "default" }> = {
  not_started: { label: "생성 안 함", tone: "muted" },
  pending: { label: "생성 예정", tone: "warning" },
  generating: { label: "임베딩 생성 중", tone: "default" },
  ready: { label: "임베딩 생성 완료", tone: "success" },
  failed: { label: "임베딩 생성 실패", tone: "warning" },
};

const ragRoleLabels: Record<RagColumnRole, string> = {
  document_text: "본문",
  document_title: "문서 제목",
  filter: "필터",
  identifier: "식별자",
  exclude: "제외",
};

function principalLabel(principalId: string) {
  if (principalId === "analytics-team") return "Analytics Team";
  if (principalId === "finance-team") return "Finance Team";
  if (principalId === "public") return "전체 사용자";
  return principalId;
}

function nextMetric(index: number): SemanticMetric {
  return { id: `metric-draft-${index}`, name: `new_metric_${index}`, label: "새 계산 지표", definition: "아직 설명이 입력되지 않은 계산 지표입니다.", expression: "COUNT(*)", format: "정수", status: "draft" };
}

function cloneProfile(profile: RagDatasetProfile): RagDatasetProfile {
  return {
    ...profile,
    textColumns: [...profile.textColumns],
    titleColumns: [...profile.titleColumns],
    filterColumns: [...profile.filterColumns],
    excludedColumns: [...profile.excludedColumns],
    recommendations: profile.recommendations.map((recommendation) => ({ ...recommendation })),
    sampleRows: profile.sampleRows.map((row) => ({ ...row })),
    vectorDocuments: profile.vectorDocuments.map((document) => ({ ...document, metadata: { ...document.metadata } })),
  };
}

function RagStatus({ profile }: { profile: RagDatasetProfile }) {
  const classification = classificationMeta[profile.classification];
  const index = indexMeta[profile.indexStatus];
  return (
    <div className="semantic-rag-statuses">
      <Badge size="sm" variant={classification.tone}>{classification.label}</Badge>
      <Badge size="sm" variant={index.tone}>{index.label}</Badge>
    </div>
  );
}

function RagColumnPill({ role, column }: { role: "text" | "filter" | "exclude"; column: string }) {
  return <span className={`semantic-rag-column-pill ${role}`}><span>{role === "text" ? "본문" : role === "filter" ? "필터" : "제외"}</span><code>{column}</code></span>;
}

export function SemanticLayerPage({ datasets, onAction, onAskAssistant }: { datasets: CatalogDataset[]; onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void; onAskAssistant: (prompt: string) => void }) {
  const [models, setModels] = useState<SemanticLayerModel[]>(cloneSemanticModels);
  const [profiles, setProfiles] = useState<RagDatasetProfile[]>(cloneSemanticRagProfiles);
  const [selectedId, setSelectedId] = useState(models[0]?.id ?? "");
  const [activeTab, setActiveTab] = useState<SemanticTab>("summary");
  const [savedAt, setSavedAt] = useState("저장되지 않은 변경 없음");
  const indexingTimers = useRef<number[]>([]);
  useEffect(() => () => { indexingTimers.current.forEach((timer) => window.clearTimeout(timer)); }, []);
  const selected = models.find((model) => model.id === selectedId) ?? models[0];

  const selectedDatasetNames = useMemo(() => selected?.linkedDatasetIds.map((id) => datasets.find((dataset) => dataset.id === id)?.name ?? id) ?? [], [datasets, selected]);
  const selectedProfiles = useMemo(() => selected?.linkedDatasetIds.map((id) => profiles.find((profile) => profile.datasetId === id)).filter(Boolean) as RagDatasetProfile[] ?? [], [profiles, selected]);
  const approvedRagCount = selectedProfiles.filter((profile) => profile.reviewState === "approved").length;
  const readyRagCount = selectedProfiles.filter((profile) => profile.indexStatus === "ready").length;

  if (!selected) return null;

  const updateSelected = (update: (model: SemanticLayerModel) => SemanticLayerModel) => {
    setModels((current) => current.map((model) => model.id === selected.id ? update(model) : model));
    setSavedAt("저장되지 않은 변경 있음");
  };

  const updateProfile = (datasetId: string, update: (profile: RagDatasetProfile) => RagDatasetProfile) => {
    setProfiles((current) => current.map((profile) => profile.datasetId === datasetId ? update(cloneProfile(profile)) : profile));
    setSavedAt("저장되지 않은 변경 있음");
  };

  const createModel = () => {
    const next: SemanticLayerModel = {
      id: `semantic-draft-${Date.now()}`,
      name: "새 업무 모델",
      description: "Catalog Dataset과 업무 정의를 연결해 보세요.",
      purpose: "이 모델에서 사용할 Dataset과 Metric을 정의합니다.",
      questionExamples: [],
      owner: "현재 사용자",
      updatedAt: "방금 생성",
      status: "draft",
      linkedDatasetIds: [],
      metrics: [],
      dimensions: [],
      relationships: [],
      synonyms: [],
      permissionGrants: [],
    };
    setModels((current) => [next, ...current]);
    setSelectedId(next.id);
    setActiveTab("summary");
    onAction("semantic_layer.created", "/mock/semantic-layers", next.id);
  };

  const saveSelected = () => {
    setSavedAt("방금 저장됨 · Mock 상태");
    onAction("semantic_layer.saved", "/mock/semantic-layers", selected.id, "success");
  };

  const publishSelected = () => {
    const blocked = selectedProfiles.some((profile) => profile.reviewState === "needs_review" || profile.indexStatus === "failed");
    if (blocked) {
      setActiveTab("datasets");
      setSavedAt("RAG 설정 확인 필요");
      onAction("semantic_layer.publish_blocked", "/mock/semantic-layers", selected.id, "failed");
      return;
    }
    updateSelected((model) => ({ ...model, status: "published", updatedAt: "방금 Publish" }));
    setSavedAt("Publish 완료 · 통합 챗봇에서 사용 가능");
    onAction("semantic_layer.published", "/mock/semantic-layers", selected.id, "success");
  };

  const addMetric = () => {
    updateSelected((model) => ({ ...model, metrics: [...model.metrics, nextMetric(model.metrics.length + 1)] }));
    setActiveTab("metrics");
  };

  const toggleDataset = (datasetId: string) => {
    const checked = selected.linkedDatasetIds.includes(datasetId);
    updateSelected((model) => ({ ...model, linkedDatasetIds: checked ? model.linkedDatasetIds.filter((id) => id !== datasetId) : [...model.linkedDatasetIds, datasetId] }));
  };

  const rerunAiReview = (profile: RagDatasetProfile) => {
    updateProfile(profile.datasetId, (current) => ({ ...current, aiReviewedAt: "방금 전", reviewState: current.classification === "analytics_only" ? "excluded" : "needs_review", indexStatus: "not_indexed", indexedRows: current.classification === "analytics_only" ? "색인 안 함" : "승인 후 색인 예정", documentCount: current.classification === "analytics_only" ? "0개" : "4.2M개 대상 · 승인 후 적재", embeddingStatus: current.classification === "analytics_only" ? "not_started" : "pending", vectorDocuments: current.vectorDocuments.map((document) => ({ ...document, embeddingStatus: "pending" })) }));
    onAction("catalog.rag.ai_review_requested", "/mock/catalog/rag/classify", profile.datasetId, "success");
  };

  const approveAndIndex = (profile: RagDatasetProfile) => {
    updateProfile(profile.datasetId, (current) => ({ ...current, reviewState: "approved", indexStatus: "indexing", embeddingStatus: current.vectorDocuments.length ? "generating" : "not_started", vectorDocuments: current.vectorDocuments.map((document) => ({ ...document, embeddingStatus: "generating" })) }));
    setSavedAt("RAG 색인을 시작했습니다");
    const timer = window.setTimeout(() => {
      updateProfile(profile.datasetId, (current) => ({ ...current, indexStatus: "ready", embeddingStatus: current.vectorDocuments.length ? "ready" : "not_started", indexedRows: current.datasetId === "ds_customer_review_gold" ? "4.2M개 중 4.2M개" : current.indexedRows, documentCount: current.datasetId === "ds_customer_review_gold" ? "4.2M개 대상 · 4.2M개 적재" : current.documentCount, lastIndexedAt: "방금 전", vectorDocuments: current.vectorDocuments.map((document) => ({ ...document, embeddingStatus: "ready" })) }));
      setSavedAt("RAG 색인 완료 · Mock 상태");
    }, 900);
    indexingTimers.current.push(timer);
    onAction("catalog.rag.index_started", "/mock/catalog/rag/index", profile.datasetId, "success");
  };

  const updateAccessGrant = (grantId: string, action: SemanticPermissionAction, checked: boolean) => {
    updateSelected((model) => ({ ...model, permissionGrants: model.permissionGrants.map((grant) => grant.id !== grantId ? grant : { ...grant, actions: checked ? [...new Set([...grant.actions, action])] : grant.actions.filter((item) => item !== action) }) }));
  };

  const addAccessRule = () => {
    updateSelected((model) => ({ ...model, permissionGrants: [...model.permissionGrants, createSemanticPermissionGrant(`semantic-access-${Date.now()}`)] }));
    setActiveTab("access");
  };

  const tabs: Array<{ id: SemanticTab; label: string; count?: number }> = [
    { id: "summary", label: "모델 요약" },
    { id: "metrics", label: "계산 지표", count: selected.metrics.length },
    { id: "dimensions", label: "분석 기준", count: selected.dimensions.length },
    { id: "datasets", label: "데이터 연결", count: selected.linkedDatasetIds.length },
    { id: "vocabulary", label: "업무 용어", count: selected.synonyms.length },
    { id: "access", label: "접근 권한", count: selected.permissionGrants.length },
  ];

  return (
    <section className="semantic-layer-page" aria-label="업무 모델 관리">
      <div className="semantic-workspace-header">
        <div className="semantic-workspace-title">
          <div className="semantic-title-mark"><Sparkles size={17} /></div>
          <div><span className="semantic-eyebrow">CATALOG · 업무 모델</span><h1>업무 모델</h1><p>Metric, Dimension, Dataset과 RAG 검색 범위를 하나의 업무 기준으로 관리합니다.</p></div>
        </div>
        <div className="semantic-header-actions">
          <span className="semantic-save-state">{savedAt}</span>
          <Button size="sm" type="button" variant="outline" onClick={createModel}><Plus /> 새 업무 모델</Button>
          <Button size="sm" type="button" variant="outline" onClick={saveSelected}><Save /> 저장</Button>
          <Button size="sm" type="button" onClick={publishSelected}><Check /> Publish</Button>
        </div>
      </div>

      <div className="semantic-layer-layout">
        <Panel asChild className="semantic-model-list" overflow="visible">
          <aside aria-label="업무 모델 목록">
            <div className="semantic-list-heading">
              <div><span className="semantic-section-label">업무 모델</span><strong>{models.length}개 모델</strong><small className="semantic-model-list-hint">통합 챗봇과 SQL이 사용할 기준을 선택합니다.</small></div>
              <Button aria-label="업무 모델 추가" size="iconSm" type="button" variant="ghost" onClick={createModel}><Plus size={16} /></Button>
            </div>
            <div className="semantic-model-items">
              {models.map((model) => {
                const modelRagCount = model.linkedDatasetIds.filter((id) => profiles.find((profile) => profile.datasetId === id)?.reviewState === "approved").length;
                return <button className={model.id === selected.id ? "semantic-model-item active" : "semantic-model-item"} key={model.id} type="button" onClick={() => { setSelectedId(model.id); setActiveTab("summary"); }}><span className="semantic-model-icon"><Sparkles size={15} /></span><span className="semantic-model-copy"><strong>{model.name}</strong><small>{model.linkedDatasetIds.length}개 Dataset · {model.metrics.length}개 Metric{modelRagCount ? ` · RAG ${modelRagCount}` : ""}</small></span><ChevronRight size={15} /></button>;
              })}
            </div>
            <div className="semantic-list-note"><span className="semantic-status-dot published" /><span><strong>Publish된 모델만</strong> 통합 챗봇과 Semantic Query에 노출됩니다.</span></div>
          </aside>
        </Panel>

        <Panel asChild className="semantic-editor" overflow="visible">
          <main>
            <div className="semantic-editor-topline"><div><Badge size="sm" variant={selected.status === "published" ? "success" : "warning"}>{selected.status === "published" ? "PUBLISHED" : "DRAFT"}</Badge><span className="semantic-updated">최근 수정 {selected.updatedAt} · 소유자 {selected.owner}</span></div><Button className="semantic-nessie-test" size="sm" type="button" variant="ghost" onClick={() => onAskAssistant(`${selected.name} 모델의 Dataset 연결과 RAG 검색 설정을 설명해줘`)}><img src={askLakeNessiIconUrl} alt="" /> Nessie로 테스트</Button></div>
            <div className="semantic-model-form"><label><span>모델 이름</span><Input value={selected.name} onChange={(event) => updateSelected((model) => ({ ...model, name: event.target.value }))} /></label><label><span>모델 설명</span><Textarea rows={2} value={selected.description} onChange={(event) => updateSelected((model) => ({ ...model, description: event.target.value }))} /></label></div>
            <div className="semantic-tab-list" role="tablist" aria-label="업무 모델 편집 탭">{tabs.map((tab) => <button aria-selected={activeTab === tab.id} className={activeTab === tab.id ? "semantic-tab active" : "semantic-tab"} key={tab.id} role="tab" type="button" onClick={() => setActiveTab(tab.id)}>{tab.label}{typeof tab.count === "number" ? <span>{tab.count}</span> : null}</button>)}</div>

            {activeTab === "summary" && <SummaryTab selected={selected} datasets={datasets} selectedProfiles={selectedProfiles} approvedRagCount={approvedRagCount} readyRagCount={readyRagCount} onOpenDatasets={() => setActiveTab("datasets")} />}
            {activeTab === "metrics" && <DefinitionsTab kind="metrics" selected={selected} onAddMetric={addMetric} onDeleteMetric={(id) => updateSelected((model) => ({ ...model, metrics: model.metrics.filter((metric) => metric.id !== id) }))} />}
            {activeTab === "dimensions" && <DefinitionsTab kind="dimensions" selected={selected} />}
            {activeTab === "datasets" && <DatasetsTab datasets={datasets} selected={selected} profiles={profiles} onToggleDataset={toggleDataset} onRerunAiReview={rerunAiReview} onApproveAndIndex={approveAndIndex} />}
            {activeTab === "vocabulary" && <VocabularyTab selected={selected} onUpdate={updateSelected} />}
            {activeTab === "access" && <AccessTab selected={selected} onAdd={addAccessRule} onUpdate={updateAccessGrant} onDelete={(id) => updateSelected((model) => ({ ...model, permissionGrants: model.permissionGrants.filter((grant) => grant.id !== id) }))} />}

            <footer className="semantic-editor-footer"><span><Database size={14} /> 연결 Dataset: {selectedDatasetNames.join(", ") || "없음"}</span><span><Bot size={14} /> RAG 검색 {approvedRagCount ? `${approvedRagCount}개 Dataset 승인` : "미설정"}</span></footer>
          </main>
        </Panel>
      </div>
    </section>
  );
}

function SummaryTab({ selected, datasets, selectedProfiles, approvedRagCount, readyRagCount, onOpenDatasets }: { selected: SemanticLayerModel; datasets: CatalogDataset[]; selectedProfiles: RagDatasetProfile[]; approvedRagCount: number; readyRagCount: number; onOpenDatasets: () => void }) {
  return <div className="semantic-tab-content semantic-summary-content">
    <Card className="semantic-summary-intro" size="lg" variant="muted"><div className="semantic-summary-intro-copy"><span className="semantic-section-label">MODEL SCOPE</span><h2>{selected.name}</h2><p>{selected.purpose}</p></div><div className="semantic-publish-state"><Badge size="sm" variant={selected.status === "published" ? "success" : "warning"}>{selected.status === "published" ? "통합 챗봇 사용 중" : "Publish 전"}</Badge><small>{selected.status === "published" ? "승인된 정의와 연결 데이터만 사용" : "Publish하면 통합 챗봇에 노출"}</small></div></Card>
    <div className="semantic-summary-grid">
      <Card className="semantic-summary-panel" size="none"><PanelHeader size="section" bordered={false} icon={<Database />} iconVariant="neutral" title="사용 Dataset" description="이 모델이 조회할 Catalog Dataset" actions={<Button size="sm" type="button" variant="outline" onClick={onOpenDatasets}>연결 편집 <ChevronRight size={14} /></Button>} /><div className="semantic-summary-dataset-list">{selected.linkedDatasetIds.length ? selected.linkedDatasetIds.map((id) => { const dataset = datasets.find((item) => item.id === id); const profile = selectedProfiles.find((item) => item.datasetId === id); return <div className="semantic-summary-dataset-row" key={id}><span className="semantic-dataset-symbol"><Database size={15} /></span><div><strong>{dataset?.name ?? id}</strong><small>{dataset ? `${dataset.layer} · ${dataset.rows}` : "Catalog Dataset"}</small></div>{profile ? <RagStatus profile={profile} /> : <Badge size="sm" variant="muted">RAG 설정 없음</Badge>}</div>; }) : <div className="semantic-empty-inline">연결된 Dataset이 없습니다.</div>}</div></Card>
      <Card className="semantic-summary-panel" size="none"><PanelHeader size="section" bordered={false} icon={<Bot />} iconVariant="outline" title="RAG 검색 준비" description="Dataset의 텍스트 컬럼을 검색에 사용할지 결정" /><div className="semantic-rag-readiness"><div className="semantic-rag-readiness-score"><strong>{readyRagCount}/{approvedRagCount || selectedProfiles.length}</strong><span>승인된 Dataset이 검색 가능</span></div><div className="semantic-progress"><span style={{ width: `${selectedProfiles.length ? Math.round((readyRagCount / selectedProfiles.length) * 100) : 0}%` }} /></div><div className="semantic-rag-steps"><span className={approvedRagCount ? "done" : ""}><Check size={13} /> Catalog 컬럼 검사</span><span className={approvedRagCount ? "done" : ""}><Check size={13} /> AI 추천 확인</span><span className={readyRagCount ? "done" : ""}><Check size={13} /> 관리자 승인·색인</span></div><Button className="semantic-rag-link" size="sm" type="button" variant="link" onClick={onOpenDatasets}>RAG 설정 보기 <ChevronRight size={14} /></Button></div></Card>
    </div>
    <div className="semantic-summary-counts" aria-label="모델 정의 수"><SummaryCount value={selected.metrics.length} label="계산 지표" icon={<Sparkles />} /><SummaryCount value={selected.dimensions.length} label="분석 기준" icon={<Hash />} /><SummaryCount value={selected.relationships.length} label="데이터 연결" icon={<Workflow />} /><SummaryCount value={selected.synonyms.length} label="업무 용어" icon={<FileText />} /></div>
    <Card className="semantic-flow-panel" size="none"><PanelHeader size="section" bordered={false} icon={<CheckCircle2 />} iconVariant="success" title="이 모델의 사용 경계" description="정형 분석과 텍스트 검색을 Dataset 단위로 분리합니다." /><div className="semantic-flow-grid"><div><span className="semantic-flow-label">정형 데이터</span><strong>Metric · Dimension · Relationship</strong><small>SQL과 Semantic Query가 사용하는 정의</small></div><span className="semantic-flow-arrow">+</span><div><span className="semantic-flow-label">검색 데이터</span><strong>승인된 텍스트 컬럼</strong><small>RAG가 검색하고 출처로 보여주는 내용</small></div><span className="semantic-flow-arrow">→</span><div className="semantic-flow-result"><span className="semantic-flow-label">현재 모델</span><strong>{selected.name}</strong><small>{approvedRagCount}개 Dataset의 검색 범위가 연결됨</small></div></div></Card>
  </div>;
}

function SummaryCount({ value, label, icon }: { value: number; label: string; icon: ReactNode }) {
  return <Card className="semantic-summary-count" size="sm" variant="muted"><span>{icon}</span><strong>{value}</strong><small>{label}</small></Card>;
}

function DefinitionsTab({ kind, selected, onAddMetric, onDeleteMetric }: { kind: "metrics" | "dimensions"; selected: SemanticLayerModel; onAddMetric?: () => void; onDeleteMetric?: (id: string) => void }) {
  const isMetrics = kind === "metrics";
  return <div className="semantic-tab-content semantic-definition-table"><div className="semantic-table-heading"><div><span className="semantic-section-label">{isMetrics ? "METRICS" : "DIMENSIONS"}</span><h2>{isMetrics ? "계산 지표" : "분석 기준"}</h2><p>{isMetrics ? "SQL을 생성할 때 사용할 계산식과 표시 형식을 고정합니다." : "지역·일자·상태처럼 Metric을 나눠 보는 기준입니다."}</p></div>{isMetrics && <Button size="sm" type="button" variant="outline" onClick={onAddMetric}><Plus /> 지표 추가</Button>}</div><div className="semantic-definition-list">{isMetrics ? selected.metrics.map((metric) => <article className="semantic-definition-row" key={metric.id}><div className="semantic-definition-icon metric"><Sparkles size={15} /></div><div className="semantic-definition-copy"><div><strong>{metric.label}</strong><code>{metric.name}</code><span className={`semantic-mini-status ${metric.status === "ready" ? "ready" : "draft"}`}>{metric.status === "ready" ? "Ready" : "Draft"}</span></div><p>{metric.definition}</p><small>{metric.expression} · {metric.format}</small></div><Button aria-label={`${metric.label} 삭제`} size="iconSm" type="button" variant="ghost" onClick={() => onDeleteMetric?.(metric.id)}><Trash2 size={15} /></Button></article>) : selected.dimensions.map((dimension) => <article className="semantic-definition-row" key={dimension.id}><div className="semantic-definition-icon dimension"><Hash size={15} /></div><div className="semantic-definition-copy"><div><strong>{dimension.label}</strong><code>{dimension.name}</code></div><p>{dimension.source}</p><small>{dimension.synonyms.join(" · ")}</small></div></article>)}</div></div>;
}

function DatasetsTab({ datasets, selected, profiles, onToggleDataset, onRerunAiReview, onApproveAndIndex }: { datasets: CatalogDataset[]; selected: SemanticLayerModel; profiles: RagDatasetProfile[]; onToggleDataset: (datasetId: string) => void; onRerunAiReview: (profile: RagDatasetProfile) => void; onApproveAndIndex: (profile: RagDatasetProfile) => void }) {
  const [selectedDatasetId, setSelectedDatasetId] = useState(selected.linkedDatasetIds[0] ?? datasets[0]?.id ?? "");
  const linkedDatasets = datasets.filter((dataset) => selected.linkedDatasetIds.includes(dataset.id));
  const selectedDataset = datasets.find((dataset) => dataset.id === selectedDatasetId) ?? linkedDatasets[0] ?? datasets[0];
  const selectedProfile = profiles.find((profile) => profile.datasetId === selectedDataset?.id);
  return <div className="semantic-tab-content semantic-datasets-tab"><div className="semantic-table-heading"><div><span className="semantic-section-label">DATASETS & RETRIEVAL</span><h2>데이터 연결과 RAG 검색 설정</h2><p>Catalog Dataset을 연결하고, 어떤 컬럼을 검색에 사용할지 확인합니다.</p></div><Badge size="sm" variant="outline">{selected.linkedDatasetIds.length}개 연결</Badge></div><div className="semantic-dataset-workspace"><Panel className="semantic-dataset-picker" variant="plain" overflow="visible"><div className="semantic-panel-kicker"><span>CATALOG DATASETS</span><Button aria-label="Dataset 새로고침" size="iconSm" type="button" variant="ghost"><RefreshCw size={15} /></Button></div><div className="semantic-linked-datasets">{datasets.map((dataset) => { const checked = selected.linkedDatasetIds.includes(dataset.id); const profile = profiles.find((item) => item.datasetId === dataset.id); return <button className={selectedDataset?.id === dataset.id ? "semantic-linked-dataset selected" : "semantic-linked-dataset"} key={dataset.id} type="button" onClick={() => setSelectedDatasetId(dataset.id)}><span className={checked ? "semantic-checkbox checked" : "semantic-checkbox"} onClick={(event) => { event.stopPropagation(); onToggleDataset(dataset.id); }}>{checked ? <Check size={12} /> : null}</span><span className="semantic-linked-dataset-copy"><strong>{dataset.name}</strong><small>{dataset.layer} · {dataset.rows}</small></span><span className="semantic-dataset-row-status">{profile ? <RagStatus profile={profile} /> : <Badge size="sm" variant="muted">분류 전</Badge>}</span></button>; })}</div><p className="semantic-helper-copy"><ShieldCheck size={13} /> 연결된 Dataset의 query 권한이 없으면 Publish할 수 없습니다.</p></Panel>{selectedDataset && <DatasetRagInspector dataset={selectedDataset} profile={selectedProfile} onRerunAiReview={onRerunAiReview} onApproveAndIndex={onApproveAndIndex} />}</div><RelationshipPanel selected={selected} /></div>;
}

function VectorDocumentPreview({ profile }: { profile: RagDatasetProfile }) {
  const embedding = embeddingMeta[profile.embeddingStatus];
  if (!profile.vectorDocuments.length) return <div className="semantic-vector-empty"><Database size={18} /><div><strong>VectorDB 적재 문서가 없습니다.</strong><span>분석 전용 Dataset은 Metric·Dimension 계산에만 사용하고 텍스트 임베딩을 만들지 않습니다.</span></div></div>;
  return <div className="semantic-vector-preview"><div className="semantic-subsection-heading"><div><span className="semantic-section-label">VECTORDB DOCUMENT PREVIEW</span><h3>VectorDB 적재 문서 미리보기</h3><p>Dataset 행에서 추출한 본문·메타데이터가 검색 문서로 변환되는 모습입니다.</p></div><Badge size="sm" variant={embedding.tone}>{embedding.label}</Badge></div><div className="semantic-vector-summary"><div><span>문서 수</span><strong>{profile.documentCount}</strong></div><div><span>대상 인덱스</span><code>{profile.targetIndex}</code></div><div><span>임베딩 상태</span><strong>{embedding.label}</strong></div></div><div className="semantic-vector-documents">{profile.vectorDocuments.map((document) => <article className="semantic-vector-document" key={document.documentId}><div className="semantic-vector-document-head"><div><span>문서 ID</span><code>{document.documentId}</code></div><Badge size="sm" variant={embeddingMeta[document.embeddingStatus].tone}>{embeddingMeta[document.embeddingStatus].label}</Badge></div><div className="semantic-vector-field"><span>검색 본문</span><p>{document.body}</p></div><div className="semantic-vector-field"><span>메타데이터</span><div className="semantic-vector-metadata">{Object.entries(document.metadata).map(([key, value]) => <span key={key}><code>{key}</code><strong>{value}</strong></span>)}</div></div><div className="semantic-vector-source"><div><span>원본 Dataset · 컬럼</span><code>{document.sourceDataset}.{document.sourceColumn}</code></div><div><span>대상 인덱스</span><code>{document.targetIndex}</code></div></div></article>)}</div><p className="semantic-vector-note"><Sparkles size={13} /> 임베딩 숫자 배열은 화면에 노출하지 않고 VectorDB에 저장됩니다. 이 화면에서는 검색에 사용될 문서와 메타데이터만 확인합니다.</p></div>;
}

function DatasetRagInspector({ dataset, profile, onRerunAiReview, onApproveAndIndex }: { dataset: CatalogDataset; profile?: RagDatasetProfile; onRerunAiReview: (profile: RagDatasetProfile) => void; onApproveAndIndex: (profile: RagDatasetProfile) => void }) {
  if (!profile) return <Card className="semantic-rag-inspector" size="none"><PanelHeader size="section" icon={<Search />} iconVariant="neutral" title={dataset.name} description="이 Dataset은 아직 RAG 분류가 실행되지 않았습니다." /><div className="semantic-review-empty"><Search size={22} /><strong>Catalog 컬럼 검사를 실행하세요.</strong><p>텍스트 컬럼과 권한을 확인한 뒤 RAG 후보를 추천합니다.</p><Button size="sm" type="button" variant="outline" disabled>AI 추천 실행 · Mock</Button></div></Card>;
  const classification = classificationMeta[profile.classification];
  const ClassificationIcon = classification.icon;
  const canApprove = profile.reviewState === "candidate" || profile.reviewState === "needs_review" || profile.reviewState === "approved";
  return <Card className="semantic-rag-inspector" size="none"><PanelHeader size="section" icon={<ClassificationIcon />} iconVariant={classification.tone === "success" ? "success" : classification.tone === "warning" ? "warning" : "neutral"} title="RAG 판단 결과" description={`${dataset.name} · ${dataset.rows} · ${profile.sourceLabel}`} actions={<Button size="sm" type="button" variant="outline" onClick={() => onRerunAiReview(profile)}><RefreshCw /> AI 추천 다시 실행</Button>} /><div className="semantic-rag-inspector-body"><div className="semantic-classification-banner"><div><span className="semantic-section-label">AI CLASSIFIER</span><h3>{profile.classificationLabel}</h3><p>{profile.aiReason}</p></div><div className="semantic-confidence"><strong>{Math.round(profile.confidence * 100)}%</strong><span>신뢰도</span><small>샘플 기반 추천</small></div></div><div className="semantic-review-progress"><div className={profile.reviewState === "approved" ? "semantic-review-step done" : "semantic-review-step active"}><span>1</span><div><strong>Catalog 검사</strong><small>스키마·샘플·권한 확인</small></div></div><ChevronRight size={16} /><div className={profile.reviewState === "approved" ? "semantic-review-step done" : "semantic-review-step active"}><span>2</span><div><strong>AI 추천</strong><small>{profile.aiReviewedAt} · {profile.classificationLabel}</small></div></div><ChevronRight size={16} /><div className={profile.reviewState === "approved" ? "semantic-review-step done" : "semantic-review-step pending"}><span>3</span><div><strong>관리자 승인</strong><small>{profile.reviewState === "approved" ? "승인됨" : "승인 전"}</small></div></div></div><div className="semantic-rag-column-section"><div className="semantic-subsection-heading"><div><span className="semantic-section-label">INDEX CONFIGURATION</span><h3>검색에 사용할 컬럼</h3></div><Badge size="sm" variant={indexMeta[profile.indexStatus].tone}>{indexMeta[profile.indexStatus].label}</Badge></div><div className="semantic-rag-columns"><div><span className="semantic-column-label">본문</span>{profile.textColumns.length ? profile.textColumns.map((column) => <RagColumnPill key={column} column={column} role="text" />) : <small>없음</small>}</div><div><span className="semantic-column-label">필터</span>{profile.filterColumns.length ? profile.filterColumns.map((column) => <RagColumnPill key={column} column={column} role="filter" />) : <small>없음</small>}</div><div><span className="semantic-column-label">제외</span>{profile.excludedColumns.length ? profile.excludedColumns.map((column) => <RagColumnPill key={column} column={column} role="exclude" />) : <small>없음</small>}</div></div></div><div className="semantic-recommendation-list"><div className="semantic-subsection-heading"><div><span className="semantic-section-label">AI RECOMMENDATIONS</span><h3>AI가 제안한 컬럼 역할</h3></div><small>관리자 승인 전 검토</small></div>{profile.recommendations.length ? profile.recommendations.map((recommendation) => <div className="semantic-recommendation-row" key={`${recommendation.column}-${recommendation.role}`}><div><code>{recommendation.column}</code><span>{ragRoleLabels[recommendation.role]}</span></div><div><strong>{Math.round(recommendation.confidence * 100)}%</strong><small>{recommendation.reason}</small></div></div>) : <div className="semantic-review-empty"><p>Catalog 검사 결과 추천할 검색 컬럼이 없습니다.</p></div>}</div><VectorDocumentPreview profile={profile} /><div className="semantic-rag-inspector-footer"><div><span className="semantic-rag-state-label">현재 상태</span><strong>{profile.reviewState === "approved" ? "관리자 승인됨" : profile.reviewState === "excluded" ? "RAG 제외" : "관리자 승인 필요"}</strong></div>{profile.reviewState !== "excluded" && <Button disabled={!canApprove || profile.indexStatus === "indexing"} size="sm" type="button" onClick={() => onApproveAndIndex(profile)}>{profile.indexStatus === "indexing" ? <><RefreshCw className="semantic-spin" /> 색인 중…</> : profile.indexStatus === "ready" ? <><Check /> 승인·색인 완료</> : <><ShieldCheck /> 승인하고 색인 시작</>}</Button>}</div></div></Card>;
}

function RelationshipPanel({ selected }: { selected: SemanticLayerModel }) {
  return <Card className="semantic-relationship-panel" size="none"><PanelHeader size="section" icon={<Workflow />} iconVariant="neutral" title="관계 정의" description="연결된 Dataset 사이에서 허용할 Join" />{selected.relationships.length ? selected.relationships.map((relationship) => <div className="semantic-relationship-row" key={relationship.id}><span className="semantic-relationship-icon"><Workflow size={15} /></span><div><strong>{relationship.label}</strong><small>{relationship.left} <b>→</b> {relationship.right}</small></div><Badge size="sm" variant="muted">{relationship.cardinality}</Badge></div>) : <div className="semantic-empty-inline">아직 관계가 없습니다.</div>}</Card>;
}

function VocabularyTab({ selected, onUpdate }: { selected: SemanticLayerModel; onUpdate: (update: (model: SemanticLayerModel) => SemanticLayerModel) => void }) {
  const [draft, setDraft] = useState("");
  const addSynonym = () => { const value = draft.trim(); if (!value) return; onUpdate((model) => ({ ...model, synonyms: model.synonyms.includes(value) ? model.synonyms : [...model.synonyms, value] })); setDraft(""); };
  return <div className="semantic-tab-content"><Card className="semantic-vocabulary-panel" size="none"><PanelHeader size="section" icon={<Hash />} iconVariant="neutral" title="업무 용어와 동의어" description="같은 의미의 표현을 하나의 Metric·Dimension으로 연결합니다." /><div className="semantic-vocabulary-body"><div className="semantic-tag-list">{selected.synonyms.map((synonym) => <span className="semantic-tag" key={synonym}>{synonym}<Button aria-label={`${synonym} 삭제`} size="iconSm" type="button" variant="ghost" onClick={() => onUpdate((model) => ({ ...model, synonyms: model.synonyms.filter((item) => item !== synonym) }))}><Trash2 size={12} /></Button></span>)}</div><div className="semantic-vocabulary-add"><Input value={draft} placeholder="동의어를 입력하고 Enter" onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addSynonym(); }} /><Button size="sm" type="button" variant="outline" onClick={addSynonym}><Plus /> 추가</Button></div></div></Card><Card className="semantic-vocabulary-note" size="sm" variant="muted"><Sparkles size={17} /><div><strong>RAG 검색과의 관계</strong><p>업무 용어는 모델 정의를 찾는 데 사용되고, 승인된 텍스트 컬럼의 문서 검색은 Dataset RAG 설정을 따릅니다.</p></div></Card></div>;
}

function AccessTab({ selected, onAdd, onUpdate, onDelete }: { selected: SemanticLayerModel; onAdd: () => void; onUpdate: (grantId: string, action: SemanticPermissionAction, checked: boolean) => void; onDelete: (id: string) => void }) {
  return <div className="semantic-tab-content semantic-access-page"><div className="semantic-table-heading"><div><span className="semantic-section-label">MODEL ACCESS</span><h2>접근 권한</h2><p>모델 보기·조회·Publish와 통합 챗봇 사용 주체를 제한합니다.</p></div><Button size="sm" type="button" variant="outline" onClick={onAdd}><Plus /> 권한 규칙 추가</Button></div><Card className="semantic-access-panel" size="none"><div className="semantic-access-notice"><ShieldCheck size={16} /><span>실제 실행 시 모델 권한과 연결 Dataset의 query 권한을 모두 확인합니다.</span></div><div className="semantic-access-table-head"><span>주체</span><span>권한</span><span>삭제</span></div>{selected.permissionGrants.length ? selected.permissionGrants.map((grant) => <div className="semantic-access-row" key={grant.id}><div className="semantic-access-principal"><span className="semantic-access-principal-icon">{grant.principalType === "group" ? <Boxes size={16} /> : grant.principalType === "public" ? <ShieldCheck size={16} /> : <CircleUser size={16} />}</span><div><strong>{principalLabel(grant.principalId)}</strong><small>{grant.principalType === "group" ? "그룹" : grant.principalType === "public" ? "전체" : "사용자"}</small></div></div><div className="semantic-access-actions">{accessActions.map((action) => { const checked = grant.actions.includes(action); return <label className={checked ? "semantic-access-toggle checked" : "semantic-access-toggle"} key={action}><input checked={checked} type="checkbox" onChange={(event) => onUpdate(grant.id ?? "", action, event.target.checked)} /><span>{accessActionLabels[action]}</span></label>; })}</div><Button aria-label={`${principalLabel(grant.principalId)} 권한 삭제`} size="iconSm" type="button" variant="ghost" onClick={() => onDelete(grant.id ?? "")}><Trash2 size={15} /></Button></div>) : <div className="semantic-empty-state"><ShieldCheck size={22} /><strong>권한 규칙이 없습니다.</strong><span>권한 규칙을 추가해야 모델을 사용할 수 있습니다.</span></div>}</Card></div>;
}
