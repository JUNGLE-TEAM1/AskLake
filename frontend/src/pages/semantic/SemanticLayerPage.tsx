import {
  AlertTriangle,
  ArrowUp,
  Bot,
  Boxes,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleUser,
  Database,
  FileText,
  Hash,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  Workflow,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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
  type RagReviewState,
  type SemanticDimension,
  type SemanticLayerModel,
  type SemanticMetric,
  type SemanticPermissionAction,
  type SemanticRelationship,
} from "../../data/semanticLayerMock";
import askLakeNessiIconUrl from "../../assets/asklake-nessi-icon.png";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";

type SemanticTab = "datasets" | "metrics" | "dimensions" | "rag" | "questions" | "access";

type ValidationIssue = {
  id: string;
  label: string;
  tab: SemanticTab;
};

type ValidationResult = {
  issues: ValidationIssue[];
  valid: boolean;
};

const accessActions: SemanticPermissionAction[] = ["view", "query", "manage", "publish"];
const accessActionLabels: Record<SemanticPermissionAction, string> = {
  view: "보기",
  query: "질의",
  run: "실행",
  manage: "관리",
  delete: "삭제",
  publish: "게시",
  share: "공유",
};

const classificationMeta: Record<RagClassification, { label: string; tone: "success" | "muted" | "warning" | "default"; icon: typeof FileText }> = {
  analytics_only: { label: "분석 전용", tone: "muted", icon: Database },
  review: { label: "고객 리뷰", tone: "success", icon: FileText },
  support_conversation: { label: "상담 대화", tone: "default", icon: Bot },
  incident_report: { label: "장애 보고", tone: "warning", icon: AlertTriangle },
  business_document: { label: "업무 문서", tone: "default", icon: FileText },
  mixed: { label: "혼합 데이터", tone: "warning", icon: Boxes },
  unknown: { label: "판단 필요", tone: "warning", icon: Search },
};

const reviewMeta: Record<RagReviewState, { label: string; tone: "success" | "muted" | "warning" | "default" }> = {
  not_configured: { label: "분류 전", tone: "muted" },
  classifying: { label: "분류 중", tone: "default" },
  candidate: { label: "RAG 후보", tone: "default" },
  needs_review: { label: "검토 필요", tone: "warning" },
  approved: { label: "승인됨", tone: "success" },
  excluded: { label: "RAG 제외", tone: "muted" },
  failed: { label: "분류 실패", tone: "warning" },
};

const indexMeta: Record<RagIndexStatus, { label: string; tone: "success" | "muted" | "warning" | "default" }> = {
  not_indexed: { label: "색인 전", tone: "muted" },
  queued: { label: "색인 대기", tone: "warning" },
  indexing: { label: "색인 중", tone: "default" },
  ready: { label: "검색 가능", tone: "success" },
  failed: { label: "색인 실패", tone: "warning" },
  canceled: { label: "색인 취소", tone: "muted" },
};

const embeddingMeta: Record<RagEmbeddingStatus, { label: string; tone: "success" | "muted" | "warning" | "default" }> = {
  not_started: { label: "생성 안 함", tone: "muted" },
  pending: { label: "생성 예정", tone: "warning" },
  generating: { label: "임베딩 생성 중", tone: "default" },
  ready: { label: "임베딩 완료", tone: "success" },
  failed: { label: "임베딩 실패", tone: "warning" },
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
  return {
    id: `metric-draft-${index}`,
    name: `new_metric_${index}`,
    label: "새 지표",
    definition: "지표가 의미하는 값을 설명해 주세요.",
    expression: "COUNT(*)",
    format: "정수",
    status: "draft",
  };
}

function nextDimension(index: number): SemanticDimension {
  return {
    id: `dimension-draft-${index}`,
    name: `new_dimension_${index}`,
    label: "새 분석 기준",
    source: "dataset.column",
    synonyms: [],
  };
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

function isRagReady(profile: RagDatasetProfile) {
  return profile.reviewState === "approved" && profile.indexStatus === "ready" && profile.embeddingStatus === "ready" && profile.targetIndex !== "";
}

function RagStatus({ profile }: { profile: RagDatasetProfile }) {
  const ready = isRagReady(profile);
  return (
    <div className="semantic-rag-statuses">
      <Badge size="sm" variant={reviewMeta[profile.reviewState].tone}>{reviewMeta[profile.reviewState].label}</Badge>
      <Badge size="sm" variant={ready ? "success" : indexMeta[profile.indexStatus].tone}>{ready ? "검색 가능" : indexMeta[profile.indexStatus].label}</Badge>
    </div>
  );
}

function RagColumnPill({ role, column }: { role: "text" | "title" | "filter" | "exclude"; column: string }) {
  const labels = { text: "본문", title: "제목", filter: "필터", exclude: "제외" };
  return <span className={`semantic-rag-column-pill ${role}`}><span>{labels[role]}</span><code>{column}</code></span>;
}

export function SemanticLayerPage({ datasets, onAction, onAskAssistant }: { datasets: CatalogDataset[]; onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void; onAskAssistant: (prompt: string) => void }) {
  const [models, setModels] = useState<SemanticLayerModel[]>(cloneSemanticModels);
  const [profiles, setProfiles] = useState<RagDatasetProfile[]>(cloneSemanticRagProfiles);
  const [selectedId, setSelectedId] = useState(models[0]?.id ?? "");
  const [activeTab, setActiveTab] = useState<SemanticTab>("dimensions");
  const [savedAt, setSavedAt] = useState("저장되지 않은 변경 없음");
  const [modelInfoOpen, setModelInfoOpen] = useState(false);
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
  const asyncTimers = useRef<number[]>([]);

  useEffect(() => () => { asyncTimers.current.forEach((timer) => window.clearTimeout(timer)); }, []);

  const selected = models.find((model) => model.id === selectedId) ?? models[0];
  const selectedProfiles = useMemo(
    () => selected?.linkedDatasetIds.map((id) => profiles.find((profile) => profile.datasetId === id)).filter(Boolean) as RagDatasetProfile[] ?? [],
    [profiles, selected],
  );
  const readyRagCount = selectedProfiles.filter(isRagReady).length;

  if (!selected) return null;

  const updateSelected = (update: (model: SemanticLayerModel) => SemanticLayerModel) => {
    setModels((current) => current.map((model) => model.id === selected.id ? update(model) : model));
    setSavedAt("저장되지 않은 변경 있음");
    setValidationResult(null);
  };

  const updateProfile = (datasetId: string, update: (profile: RagDatasetProfile) => RagDatasetProfile) => {
    setProfiles((current) => current.map((profile) => profile.datasetId === datasetId ? update(cloneProfile(profile)) : profile));
    setSavedAt("저장되지 않은 변경 있음");
    setValidationResult(null);
  };

  const selectModel = (modelId: string) => {
    setSelectedId(modelId);
    setActiveTab("dimensions");
    setModelInfoOpen(false);
    setValidationResult(null);
  };

  const createModel = () => {
    const next: SemanticLayerModel = {
      id: `semantic-draft-${Date.now()}`,
      version: 1,
      name: "새 업무 모델",
      description: "Catalog Dataset과 업무 정의를 연결해 보세요.",
      purpose: "이 모델에서 사용할 Dataset과 지표를 정의합니다.",
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
    setActiveTab("datasets");
    setModelInfoOpen(true);
    setValidationResult(null);
    onAction("semantic_layer.created", "/mock/semantic-layers", next.id);
  };

  const saveSelected = () => {
    setSavedAt("방금 저장됨 · 프런트 Mock");
    onAction("semantic_layer.saved", "/mock/semantic-layers", selected.id, "success");
  };

  const collectValidationIssues = (): ValidationIssue[] => {
    const issues: ValidationIssue[] = [];
    if (!selected.linkedDatasetIds.length) issues.push({ id: "dataset", label: "연결된 Dataset이 없습니다.", tab: "datasets" });
    if (!selected.metrics.length) issues.push({ id: "metric", label: "지표를 하나 이상 정의해 주세요.", tab: "metrics" });
    if (selected.metrics.some((metric) => metric.status === "draft")) issues.push({ id: "metric-draft", label: "작성 중인 지표 정의를 완료해 주세요.", tab: "metrics" });
    if (!selected.dimensions.length) issues.push({ id: "dimension", label: "분석 기준을 하나 이상 정의해 주세요.", tab: "dimensions" });
    if (selected.linkedDatasetIds.length > 1 && !selected.relationships.length) issues.push({ id: "relationship", label: "Dataset 간 관계를 정의해 주세요.", tab: "datasets" });
    if (selectedProfiles.some((profile) => profile.reviewState === "needs_review" || profile.reviewState === "failed" || profile.indexStatus === "failed")) {
      issues.push({ id: "rag", label: "검토 또는 재시도가 필요한 RAG Dataset이 있습니다.", tab: "rag" });
    }
    return issues;
  };

  const validateSelected = () => {
    const issues = collectValidationIssues();
    const result = { issues, valid: issues.length === 0 };
    setValidationResult(result);
    setSavedAt(result.valid ? "검증 통과 · 게시 가능" : `검증 결과 · ${issues.length}개 확인 필요`);
    onAction("semantic_layer.validated", "/mock/semantic-layers/validate", selected.id, result.valid ? "success" : "failed");
    return result;
  };

  const publishSelected = () => {
    const result = validateSelected();
    if (!result.valid) {
      onAction("semantic_layer.publish_blocked", "/mock/semantic-layers", selected.id, "failed");
      return;
    }
    setModels((current) => current.map((model) => model.id === selected.id ? { ...model, status: "published" as const, updatedAt: "방금 게시" } : model));
    setSavedAt("게시 완료 · 통합 챗봇에서 사용 가능");
    setValidationResult({ issues: [], valid: true });
    onAction("semantic_layer.published", "/mock/semantic-layers", selected.id, "success");
  };

  const addMetric = () => {
    updateSelected((model) => ({ ...model, metrics: [...model.metrics, nextMetric(model.metrics.length + 1)] }));
    setActiveTab("metrics");
  };

  const addDimension = () => {
    updateSelected((model) => ({ ...model, dimensions: [...model.dimensions, nextDimension(model.dimensions.length + 1)] }));
    setActiveTab("dimensions");
  };

  const addRelationship = () => {
    const linked = datasets.filter((dataset) => selected.linkedDatasetIds.includes(dataset.id));
    if (linked.length < 2) return;
    const left = linked[0];
    const right = linked[1];
    const relationship: SemanticRelationship = {
      id: `relationship-${Date.now()}`,
      label: `${left.name} ↔ ${right.name}`,
      left: `${left.name}.${left.schema[0]?.[0] ?? "id"}`,
      right: `${right.name}.${right.schema[0]?.[0] ?? "id"}`,
      cardinality: "1:N",
    };
    updateSelected((model) => ({ ...model, relationships: [...model.relationships, relationship] }));
  };

  const toggleDataset = (datasetId: string) => {
    const checked = selected.linkedDatasetIds.includes(datasetId);
    updateSelected((model) => ({
      ...model,
      linkedDatasetIds: checked ? model.linkedDatasetIds.filter((id) => id !== datasetId) : [...model.linkedDatasetIds, datasetId],
    }));
  };

  const rerunAiReview = (profile: RagDatasetProfile) => {
    updateProfile(profile.datasetId, (current) => ({
      ...current,
      aiReviewedAt: "분류 중",
      reviewState: "classifying",
      indexStatus: "not_indexed",
      embeddingStatus: current.classification === "analytics_only" ? "not_started" : "pending",
    }));
    const timer = window.setTimeout(() => {
      updateProfile(profile.datasetId, (current) => ({
        ...current,
        aiReviewedAt: "방금 전",
        reviewState: current.classification === "analytics_only" ? "excluded" : "needs_review",
      }));
    }, 650);
    asyncTimers.current.push(timer);
    onAction("catalog.rag.ai_review_requested", "/mock/catalog/rag/classify", profile.datasetId, "success");
  };

  const requestClassification = (dataset: CatalogDataset) => {
    const existing = profiles.find((profile) => profile.datasetId === dataset.id);
    if (existing) {
      rerunAiReview(existing);
      return;
    }
    const textColumns = dataset.schema.filter(([, type]) => /char|string|text/i.test(type)).map(([column]) => column);
    const draft: RagDatasetProfile = {
      datasetId: dataset.id,
      classification: "unknown",
      classificationLabel: "분류 중",
      confidence: 0,
      aiReason: "Catalog 스키마와 제한된 샘플을 검사하고 있습니다.",
      aiReviewedAt: "분류 중",
      reviewState: "classifying",
      indexStatus: "not_indexed",
      indexedRows: "-",
      documentCount: "승인 후 계산",
      targetIndex: dataset.name,
      embeddingStatus: "not_started",
      sourceLabel: dataset.source,
      textColumns: textColumns.slice(0, 1),
      titleColumns: [],
      filterColumns: [],
      excludedColumns: [],
      recommendations: [],
      sampleRows: [],
      vectorDocuments: [],
    };
    setProfiles((current) => [...current, draft]);
    const timer = window.setTimeout(() => {
      setProfiles((current) => current.map((profile) => profile.datasetId !== dataset.id ? profile : {
        ...profile,
        classificationLabel: "판단 필요",
        confidence: 0.72,
        aiReason: textColumns.length ? "문자열 컬럼이 확인되었습니다. 검색 본문으로 사용할지 검토해 주세요." : "검색 본문으로 사용할 장문 텍스트 컬럼이 확인되지 않았습니다.",
        aiReviewedAt: "방금 전",
        reviewState: textColumns.length ? "needs_review" : "excluded",
        classification: textColumns.length ? "unknown" : "analytics_only",
        embeddingStatus: textColumns.length ? "pending" : "not_started",
        recommendations: textColumns.slice(0, 1).map((column) => ({ column, role: "document_text" as const, reason: "문자열 컬럼 후보", confidence: 0.72 })),
      }));
    }, 700);
    asyncTimers.current.push(timer);
    setSavedAt("RAG 분류를 요청했습니다");
    onAction("catalog.rag.ai_review_requested", "/mock/catalog/rag/classify", dataset.id, "success");
  };

  const approveAndIndex = (profile: RagDatasetProfile) => {
    updateProfile(profile.datasetId, (current) => ({
      ...current,
      reviewState: "approved",
      indexStatus: "queued",
      embeddingStatus: current.vectorDocuments.length ? "pending" : "not_started",
      vectorDocuments: current.vectorDocuments.map((document) => ({ ...document, embeddingStatus: "pending" })),
    }));
    setSavedAt("RAG 색인 작업을 요청했습니다");
    const indexingTimer = window.setTimeout(() => {
      updateProfile(profile.datasetId, (current) => ({
        ...current,
        indexStatus: "indexing",
        embeddingStatus: current.vectorDocuments.length ? "generating" : "not_started",
        vectorDocuments: current.vectorDocuments.map((document) => ({ ...document, embeddingStatus: "generating" })),
      }));
    }, 300);
    const readyTimer = window.setTimeout(() => {
      updateProfile(profile.datasetId, (current) => ({
        ...current,
        indexStatus: "ready",
        embeddingStatus: current.vectorDocuments.length ? "ready" : "not_started",
        indexedRows: current.datasetId === "ds_customer_review_gold" ? "4.2M개 중 4.2M개" : current.indexedRows,
        documentCount: current.datasetId === "ds_customer_review_gold" ? "4.2M개 대상 · 4.2M개 적재" : current.documentCount,
        lastIndexedAt: "방금 전",
        vectorDocuments: current.vectorDocuments.map((document) => ({ ...document, embeddingStatus: "ready" })),
      }));
      setSavedAt("RAG 색인 완료 · 프런트 Mock");
    }, 1200);
    asyncTimers.current.push(indexingTimer, readyTimer);
    onAction("catalog.rag.index_started", "/mock/catalog/rag/index", profile.datasetId, "success");
  };

  const updateAccessGrant = (grantId: string, action: SemanticPermissionAction, checked: boolean) => {
    updateSelected((model) => ({
      ...model,
      permissionGrants: model.permissionGrants.map((grant) => grant.id !== grantId ? grant : {
        ...grant,
        actions: checked ? [...new Set([...grant.actions, action])] : grant.actions.filter((item) => item !== action),
      }),
    }));
  };

  const addAccessRule = () => {
    updateSelected((model) => ({
      ...model,
      permissionGrants: [...model.permissionGrants, createSemanticPermissionGrant(`semantic-access-${Date.now()}`)],
    }));
    setActiveTab("access");
  };

  const tabs: Array<{ id: SemanticTab; label: string; count?: number }> = [
    { id: "datasets", label: "데이터 연결", count: selected.linkedDatasetIds.length },
    { id: "metrics", label: "지표", count: selected.metrics.length },
    { id: "dimensions", label: "분석 기준 · 용어", count: selected.dimensions.length },
    { id: "rag", label: "RAG 검색", count: readyRagCount },
    { id: "questions", label: "질문 테스트" },
    { id: "access", label: "권한", count: selected.permissionGrants.length },
  ];

  return (
    <section className="semantic-layer-page" aria-label="업무 모델 관리">
      <header className="semantic-workspace-header">
        <div className="semantic-workspace-title">
          <span className="semantic-breadcrumb">Catalog / 업무 모델</span>
          <div className="semantic-title-row">
            <h1>{selected.name}</h1>
            <span className={`semantic-model-state ${selected.status}`}>{selected.status === "published" ? "게시됨" : "초안"} · v{selected.version}</span>
            <span className="semantic-owner">{selected.owner}</span>
          </div>
        </div>
        <div className="semantic-header-action-group">
          <span className="semantic-save-state">{savedAt}</span>
          <div className="semantic-header-actions">
            <Button size="sm" type="button" variant="outline" onClick={saveSelected}><Save /> 저장</Button>
            <Button size="sm" type="button" variant="outline" onClick={validateSelected}><ShieldCheck /> 검증</Button>
            <Button className="semantic-publish-button" size="sm" type="button" onClick={publishSelected}><ArrowUp /> 게시</Button>
          </div>
        </div>
      </header>

      <div className="semantic-layer-layout">
        <aside className="semantic-model-list" aria-label="업무 모델 목록">
          <div className="semantic-list-heading">
            <strong>업무 모델</strong>
            <Button aria-label="업무 모델 추가" size="iconSm" type="button" variant="ghost" onClick={createModel}><Plus size={17} /></Button>
          </div>
          <div className="semantic-model-items">
            {models.map((model) => (
              <button
                aria-current={model.id === selected.id ? "page" : undefined}
                className={model.id === selected.id ? "semantic-model-item active" : "semantic-model-item"}
                key={model.id}
                type="button"
                onClick={() => selectModel(model.id)}
              >
                <span className={`semantic-model-dot ${model.status}`} />
                <span className="semantic-model-copy">
                  <strong>{model.name}</strong>
                  <small>{model.status === "published" ? "게시됨" : "초안"} · v{model.version}</small>
                </span>
              </button>
            ))}
          </div>
          <div className="semantic-list-note"><CheckCircle2 size={15} /><span>게시된 버전만 통합 챗봇의 질의 기준으로 사용됩니다.</span></div>
        </aside>

        <main className="semantic-editor">
          <section className="semantic-model-intro">
            <div className="semantic-model-intro-copy">
              <h2>{selected.description}</h2>
              <p>{selected.purpose}</p>
              {selected.synonyms.length > 0 && <div className="semantic-model-terms" aria-label="대표 업무 용어">{selected.synonyms.slice(0, 5).map((term) => <span key={term}>{term}</span>)}</div>}
            </div>
            <Button size="sm" type="button" variant="outline" onClick={() => setModelInfoOpen((open) => !open)}><Pencil /> 모델 정보</Button>
          </section>

          {modelInfoOpen && <ModelInfoForm key={selected.id} selected={selected} onUpdate={updateSelected} />}

          <nav className="semantic-tab-list" role="tablist" aria-label="업무 모델 편집 탭">
            {tabs.map((tab) => (
              <button
                aria-selected={activeTab === tab.id}
                className={activeTab === tab.id ? "semantic-tab active" : "semantic-tab"}
                key={tab.id}
                role="tab"
                type="button"
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
                {typeof tab.count === "number" ? <span>{tab.count}</span> : null}
              </button>
            ))}
          </nav>

          {validationResult && <ValidationBanner result={validationResult} onNavigate={setActiveTab} />}

          {activeTab === "datasets" && (
            <DatasetsTab
              datasets={datasets}
              selected={selected}
              onAddRelationship={addRelationship}
              onDeleteRelationship={(id) => updateSelected((model) => ({ ...model, relationships: model.relationships.filter((relationship) => relationship.id !== id) }))}
              onOpenRag={() => setActiveTab("rag")}
              onToggleDataset={toggleDataset}
            />
          )}
          {activeTab === "metrics" && (
            <MetricsTab
              selected={selected}
              onAdd={addMetric}
              onDelete={(id) => updateSelected((model) => ({ ...model, metrics: model.metrics.filter((metric) => metric.id !== id) }))}
              onUpdate={(id, patch) => updateSelected((model) => ({ ...model, metrics: model.metrics.map((metric) => metric.id === id ? { ...metric, ...patch } : metric) }))}
            />
          )}
          {activeTab === "dimensions" && (
            <DimensionsTab
              selected={selected}
              onAdd={addDimension}
              onDelete={(id) => updateSelected((model) => ({ ...model, dimensions: model.dimensions.filter((dimension) => dimension.id !== id) }))}
              onUpdate={(id, patch) => updateSelected((model) => ({ ...model, dimensions: model.dimensions.map((dimension) => dimension.id === id ? { ...dimension, ...patch } : dimension) }))}
            />
          )}
          {activeTab === "rag" && (
            <RagTab
              datasets={datasets}
              profiles={profiles}
              selected={selected}
              onApproveAndIndex={approveAndIndex}
              onClassify={requestClassification}
              onRerunAiReview={rerunAiReview}
            />
          )}
          {activeTab === "questions" && <QuestionsTab selected={selected} onAskAssistant={onAskAssistant} />}
          {activeTab === "access" && (
            <AccessTab
              selected={selected}
              onAdd={addAccessRule}
              onDelete={(id) => updateSelected((model) => ({ ...model, permissionGrants: model.permissionGrants.filter((grant) => grant.id !== id) }))}
              onUpdate={updateAccessGrant}
            />
          )}
        </main>
      </div>
    </section>
  );
}

function ModelInfoForm({ selected, onUpdate }: { selected: SemanticLayerModel; onUpdate: (update: (model: SemanticLayerModel) => SemanticLayerModel) => void }) {
  return (
    <section className="semantic-model-form" aria-label="모델 정보 편집">
      <label><span>모델 이름</span><Input value={selected.name} onChange={(event) => onUpdate((model) => ({ ...model, name: event.target.value }))} /></label>
      <label><span>모델 설명</span><Textarea rows={2} value={selected.description} onChange={(event) => onUpdate((model) => ({ ...model, description: event.target.value }))} /></label>
      <label><span>사용 목적</span><Textarea rows={2} value={selected.purpose} onChange={(event) => onUpdate((model) => ({ ...model, purpose: event.target.value }))} /></label>
      <label><span>대표 업무 용어</span><Input defaultValue={selected.synonyms.join(", ")} placeholder="쉼표로 구분" onBlur={(event) => onUpdate((model) => ({ ...model, synonyms: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) }))} /></label>
    </section>
  );
}

function ValidationBanner({ result, onNavigate }: { result: ValidationResult; onNavigate: (tab: SemanticTab) => void }) {
  if (result.valid) {
    return <div className="semantic-validation-result success"><CheckCircle2 size={18} /><div><strong>검증을 통과했습니다.</strong><span>현재 Draft를 게시할 수 있습니다.</span></div></div>;
  }
  return (
    <div className="semantic-validation-result warning">
      <AlertTriangle size={18} />
      <div><strong>{result.issues.length}개 항목을 확인해 주세요.</strong><div className="semantic-validation-links">{result.issues.map((issue) => <button key={issue.id} type="button" onClick={() => onNavigate(issue.tab)}>{issue.label}<ChevronRight size={13} /></button>)}</div></div>
    </div>
  );
}

function SectionHeading({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description: string; actions?: React.ReactNode }) {
  return <div className="semantic-table-heading"><div><span className="semantic-section-label">{eyebrow}</span><h2>{title}</h2><p>{description}</p></div>{actions}</div>;
}

function DatasetsTab({ datasets, selected, onToggleDataset, onAddRelationship, onDeleteRelationship, onOpenRag }: { datasets: CatalogDataset[]; selected: SemanticLayerModel; onToggleDataset: (datasetId: string) => void; onAddRelationship: () => void; onDeleteRelationship: (id: string) => void; onOpenRag: () => void }) {
  return (
    <div className="semantic-tab-content semantic-datasets-tab">
      <SectionHeading
        eyebrow="DATASETS"
        title="데이터 연결"
        description="업무 모델이 조회할 Catalog Dataset과 Dataset 사이의 관계를 관리합니다."
        actions={<Button size="sm" type="button" variant="outline" onClick={onOpenRag}><Sparkles /> RAG 설정 보기</Button>}
      />
      <div className="semantic-grid-table semantic-dataset-table">
        <div className="semantic-grid-table-head"><span>Dataset</span><span>상태</span><span>조회 권한</span><span>연결</span></div>
        {datasets.map((dataset) => {
          const connected = selected.linkedDatasetIds.includes(dataset.id);
          const canQuery = dataset.permissions?.canQuery !== false;
          return (
            <div className={connected ? "semantic-grid-table-row connected" : "semantic-grid-table-row"} key={dataset.id}>
              <div className="semantic-dataset-name"><span><Database size={16} /></span><div><strong>{dataset.name}</strong><small>{dataset.layer} · {dataset.rows} · {dataset.owner}</small></div></div>
              <div><Badge size="sm" variant={dataset.status === "available" ? "success" : "warning"}>{dataset.status === "available" ? "사용 가능" : "승인 필요"}</Badge></div>
              <div className={canQuery ? "semantic-query-access allowed" : "semantic-query-access denied"}><ShieldCheck size={14} />{canQuery ? "query 허용" : "query 없음"}</div>
              <button aria-pressed={connected} className={connected ? "semantic-connect-toggle connected" : "semantic-connect-toggle"} type="button" onClick={() => onToggleDataset(dataset.id)}><span>{connected ? <Check size={12} /> : null}</span>{connected ? "연결됨" : "연결"}</button>
            </div>
          );
        })}
      </div>
      <p className="semantic-helper-copy"><ShieldCheck size={14} /> 연결 시점과 게시 시점에 Dataset의 query 권한을 다시 확인합니다.</p>
      <RelationshipPanel selected={selected} onAdd={onAddRelationship} onDelete={onDeleteRelationship} />
    </div>
  );
}

function RelationshipPanel({ selected, onAdd, onDelete }: { selected: SemanticLayerModel; onAdd: () => void; onDelete: (id: string) => void }) {
  return (
    <section className="semantic-relationship-panel">
      <SectionHeading
        eyebrow="RELATIONSHIPS"
        title="관계"
        description="연결된 Dataset 사이에서 허용할 Join을 목록으로 관리합니다."
        actions={<Button disabled={selected.linkedDatasetIds.length < 2} size="sm" type="button" variant="outline" onClick={onAdd}><Plus /> 관계 추가</Button>}
      />
      <div className="semantic-relationship-list">
        {selected.relationships.length ? selected.relationships.map((relationship) => (
          <div className="semantic-relationship-row" key={relationship.id}>
            <span className="semantic-relationship-icon"><Workflow size={16} /></span>
            <div><strong>{relationship.label}</strong><small>{relationship.left} <b>→</b> {relationship.right}</small></div>
            <Badge size="sm" variant="muted">{relationship.cardinality}</Badge>
            <Button aria-label={`${relationship.label} 삭제`} size="iconSm" type="button" variant="ghost" onClick={() => onDelete(relationship.id)}><Trash2 size={15} /></Button>
          </div>
        )) : <EmptyState icon={<Workflow size={21} />} title="정의된 관계가 없습니다." description="Dataset을 두 개 이상 연결한 뒤 관계를 추가하세요." />}
      </div>
    </section>
  );
}

function MetricsTab({ selected, onAdd, onUpdate, onDelete }: { selected: SemanticLayerModel; onAdd: () => void; onUpdate: (id: string, patch: Partial<SemanticMetric>) => void; onDelete: (id: string) => void }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  return (
    <div className="semantic-tab-content semantic-definitions-tab">
      <SectionHeading eyebrow="지표 정의" title="지표" description="질문마다 달라지지 않도록 계산식과 표시 형식을 고정합니다." actions={<Button size="sm" type="button" variant="outline" onClick={onAdd}><Plus /> 지표 추가</Button>} />
      <div className="semantic-grid-table semantic-metric-table">
        <div className="semantic-grid-table-head"><span>표시명</span><span>정의 · 계산식</span><span>표시 형식</span><span>상태</span><span /></div>
        {selected.metrics.map((metric) => editingId === metric.id ? (
          <div className="semantic-grid-table-row editing" key={metric.id}>
            <div className="semantic-edit-stack"><Input value={metric.label} onChange={(event) => onUpdate(metric.id, { label: event.target.value })} /><Input value={metric.name} onChange={(event) => onUpdate(metric.id, { name: event.target.value })} /></div>
            <div className="semantic-edit-stack"><Textarea rows={2} value={metric.definition} onChange={(event) => onUpdate(metric.id, { definition: event.target.value })} /><Input value={metric.expression} onChange={(event) => onUpdate(metric.id, { expression: event.target.value })} /></div>
            <Input value={metric.format} onChange={(event) => onUpdate(metric.id, { format: event.target.value })} />
            <Badge size="sm" variant={metric.status === "ready" ? "success" : "warning"}>{metric.status === "ready" ? "완료" : "작성 중"}</Badge>
            <div className="semantic-row-actions"><Button size="sm" type="button" variant="subtle" onClick={() => { onUpdate(metric.id, { status: "ready" }); setEditingId(null); }}><Check /> 완료</Button><Button aria-label={`${metric.label} 삭제`} size="iconSm" type="button" variant="ghost" onClick={() => onDelete(metric.id)}><Trash2 /></Button></div>
          </div>
        ) : (
          <div className="semantic-grid-table-row" key={metric.id}>
            <div className="semantic-definition-name"><strong>{metric.label}</strong><code>{metric.name}</code></div>
            <div className="semantic-definition-detail"><p>{metric.definition}</p><code>{metric.expression}</code></div>
            <span>{metric.format}</span>
            <Badge size="sm" variant={metric.status === "ready" ? "success" : "warning"}>{metric.status === "ready" ? "완료" : "작성 중"}</Badge>
            <Button className="semantic-text-action" size="content" type="button" variant="ghost" onClick={() => setEditingId(metric.id)}><Pencil /> 편집</Button>
          </div>
        ))}
        {!selected.metrics.length && <EmptyState icon={<Sparkles size={21} />} title="정의된 지표가 없습니다." description="업무에서 반복해서 묻는 숫자부터 추가하세요." />}
      </div>
    </div>
  );
}

function DimensionsTab({ selected, onAdd, onUpdate, onDelete }: { selected: SemanticLayerModel; onAdd: () => void; onUpdate: (id: string, patch: Partial<SemanticDimension>) => void; onDelete: (id: string) => void }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  return (
    <div className="semantic-tab-content semantic-definitions-tab">
      <SectionHeading eyebrow="분석 기준 · 용어" title="분석 기준 · 용어" description="지표를 나눠 보는 기준과 챗봇이 알아들을 동의어를 함께 관리합니다." actions={<Button size="sm" type="button" variant="outline" onClick={onAdd}><Plus /> 분석 기준 추가</Button>} />
      <div className="semantic-grid-table semantic-dimension-table">
        <div className="semantic-grid-table-head"><span>표시명</span><span>원본 컬럼</span><span>동의어</span><span /></div>
        {selected.dimensions.map((dimension) => editingId === dimension.id ? (
          <div className="semantic-grid-table-row editing" key={dimension.id}>
            <div className="semantic-edit-stack"><Input value={dimension.label} onChange={(event) => onUpdate(dimension.id, { label: event.target.value })} /><Input value={dimension.name} onChange={(event) => onUpdate(dimension.id, { name: event.target.value })} /></div>
            <Input value={dimension.source} onChange={(event) => onUpdate(dimension.id, { source: event.target.value })} />
            <Input defaultValue={dimension.synonyms.join(", ")} placeholder="쉼표로 구분" onBlur={(event) => onUpdate(dimension.id, { synonyms: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} />
            <div className="semantic-row-actions"><Button size="sm" type="button" variant="subtle" onClick={() => setEditingId(null)}><Check /> 완료</Button><Button aria-label={`${dimension.label} 삭제`} size="iconSm" type="button" variant="ghost" onClick={() => onDelete(dimension.id)}><Trash2 /></Button></div>
          </div>
        ) : (
          <div className="semantic-grid-table-row" key={dimension.id}>
            <div className="semantic-definition-name"><strong>{dimension.label}</strong><code>{dimension.name}</code></div>
            <code className="semantic-source-column">{dimension.source}</code>
            <div className="semantic-synonym-list">{dimension.synonyms.length ? dimension.synonyms.map((synonym) => <span key={synonym}>{synonym}</span>) : <small>동의어 없음</small>}</div>
            <Button className="semantic-text-action" size="content" type="button" variant="ghost" onClick={() => setEditingId(dimension.id)}><Pencil /> 편집</Button>
          </div>
        ))}
        {!selected.dimensions.length && <EmptyState icon={<Hash size={21} />} title="정의된 분석 기준이 없습니다." description="지역, 날짜, 상태처럼 지표를 나눠 볼 기준을 추가하세요." />}
      </div>
    </div>
  );
}

function RagTab({ datasets, selected, profiles, onClassify, onRerunAiReview, onApproveAndIndex }: { datasets: CatalogDataset[]; selected: SemanticLayerModel; profiles: RagDatasetProfile[]; onClassify: (dataset: CatalogDataset) => void; onRerunAiReview: (profile: RagDatasetProfile) => void; onApproveAndIndex: (profile: RagDatasetProfile) => void }) {
  const linkedDatasets = datasets.filter((dataset) => selected.linkedDatasetIds.includes(dataset.id));
  const [selectedDatasetId, setSelectedDatasetId] = useState(linkedDatasets[0]?.id ?? "");

  useEffect(() => {
    if (!linkedDatasets.some((dataset) => dataset.id === selectedDatasetId)) setSelectedDatasetId(linkedDatasets[0]?.id ?? "");
  }, [linkedDatasets, selectedDatasetId]);

  const linkedProfiles = linkedDatasets.map((dataset) => profiles.find((profile) => profile.datasetId === dataset.id)).filter(Boolean) as RagDatasetProfile[];
  const selectedDataset = linkedDatasets.find((dataset) => dataset.id === selectedDatasetId) ?? linkedDatasets[0];
  const selectedProfile = profiles.find((profile) => profile.datasetId === selectedDataset?.id);
  const classifiedCount = linkedProfiles.filter((profile) => profile.reviewState !== "not_configured" && profile.reviewState !== "classifying").length;
  const approvedCount = linkedProfiles.filter((profile) => profile.reviewState === "approved").length;
  const readyCount = linkedProfiles.filter(isRagReady).length;

  return (
    <div className="semantic-tab-content semantic-rag-tab">
      <SectionHeading eyebrow="RAG SEARCH" title="RAG 검색" description="연결된 Dataset을 분류하고, 추천 컬럼을 승인한 뒤 Dataset 단위로 색인합니다." />
      <div className="semantic-rag-summary" aria-label="RAG 준비 상태">
        <RagSummaryItem label="연결 Dataset" value={linkedDatasets.length} />
        <RagSummaryItem label="분류 완료" value={classifiedCount} />
        <RagSummaryItem label="승인" value={approvedCount} />
        <RagSummaryItem accent label="검색 가능" value={readyCount} />
      </div>
      {!linkedDatasets.length ? <EmptyState icon={<Database size={22} />} title="연결된 Dataset이 없습니다." description="데이터 연결 탭에서 먼저 Dataset을 연결하세요." /> : (
        <div className="semantic-rag-workspace">
          <aside className="semantic-rag-dataset-list" aria-label="RAG Dataset 목록">
            <div className="semantic-panel-kicker"><span>연결 Dataset</span><small>{linkedDatasets.length}개</small></div>
            {linkedDatasets.map((dataset) => {
              const profile = profiles.find((item) => item.datasetId === dataset.id);
              return <button className={selectedDataset?.id === dataset.id ? "semantic-rag-dataset active" : "semantic-rag-dataset"} key={dataset.id} type="button" onClick={() => setSelectedDatasetId(dataset.id)}><span className="semantic-dataset-symbol"><Database size={15} /></span><span><strong>{dataset.name}</strong><small>{dataset.layer} · {dataset.rows}</small>{profile ? <RagStatus profile={profile} /> : <Badge size="sm" variant="muted">분류 전</Badge>}</span><ChevronRight size={15} /></button>;
            })}
          </aside>
          {selectedDataset && <DatasetRagInspector dataset={selectedDataset} profile={selectedProfile} onClassify={onClassify} onRerunAiReview={onRerunAiReview} onApproveAndIndex={onApproveAndIndex} />}
        </div>
      )}
    </div>
  );
}

function RagSummaryItem({ label, value, accent = false }: { label: string; value: number; accent?: boolean }) {
  return <div className={accent ? "semantic-rag-summary-item accent" : "semantic-rag-summary-item"}><strong>{value}</strong><span>{label}</span></div>;
}

function DatasetRagInspector({ dataset, profile, onClassify, onRerunAiReview, onApproveAndIndex }: { dataset: CatalogDataset; profile?: RagDatasetProfile; onClassify: (dataset: CatalogDataset) => void; onRerunAiReview: (profile: RagDatasetProfile) => void; onApproveAndIndex: (profile: RagDatasetProfile) => void }) {
  if (!profile) {
    return <Card className="semantic-rag-inspector" size="none"><div className="semantic-rag-inspector-header"><div><span className="semantic-section-label">DATASET CLASSIFICATION</span><h3>{dataset.name}</h3><p>아직 RAG 분류가 실행되지 않았습니다.</p></div></div><div className="semantic-review-empty"><Search size={24} /><strong>AI Dataset 분류가 필요합니다.</strong><p>Catalog 스키마와 제한된 샘플만 사용해 검색 본문 후보를 찾습니다.</p><Button size="sm" type="button" onClick={() => onClassify(dataset)}><Sparkles /> AI 분류 요청</Button></div></Card>;
  }

  if (profile.reviewState === "classifying") {
    return <Card className="semantic-rag-inspector" size="none"><div className="semantic-rag-inspector-header"><div><span className="semantic-section-label">DATASET CLASSIFICATION</span><h3>{dataset.name}</h3><p>Catalog 스키마와 제한된 샘플을 분석하고 있습니다.</p></div><Badge size="sm" variant="default">분류 중</Badge></div><div className="semantic-review-empty"><RefreshCw className="semantic-spin" size={24} /><strong>AI 추천을 준비하고 있습니다.</strong><p>원본 전체 데이터는 AI 분류 요청에 포함하지 않습니다.</p></div></Card>;
  }

  const classification = classificationMeta[profile.classification];
  const ClassificationIcon = classification.icon;
  const canApprove = profile.reviewState === "candidate" || profile.reviewState === "needs_review" || profile.reviewState === "approved";
  const indexBusy = profile.indexStatus === "queued" || profile.indexStatus === "indexing";
  const reviewDone = profile.reviewState === "approved" || profile.reviewState === "excluded";
  const indexDone = profile.indexStatus === "ready";

  return (
    <Card className="semantic-rag-inspector" size="none">
      <div className="semantic-rag-inspector-header">
        <div><span className="semantic-section-label">DATASET RAG PROFILE</span><h3>{dataset.name}</h3><p>{dataset.rows} · {profile.sourceLabel} · 최근 분류 {profile.aiReviewedAt}</p></div>
        <div className="semantic-rag-inspector-actions"><Badge size="sm" variant={reviewMeta[profile.reviewState].tone}>{reviewMeta[profile.reviewState].label}</Badge><Badge size="sm" variant={indexMeta[profile.indexStatus].tone}>{indexMeta[profile.indexStatus].label}</Badge><Button aria-label="AI 추천 다시 실행" size="iconSm" type="button" variant="ghost" onClick={() => onRerunAiReview(profile)}><RefreshCw /></Button></div>
      </div>
      <div className="semantic-rag-inspector-body">
        <div className="semantic-classification-banner">
          <div className="semantic-classification-icon"><ClassificationIcon size={19} /></div>
          <div><span className="semantic-section-label">AI 분류 결과</span><h4>{profile.classificationLabel}</h4><p>{profile.aiReason}</p></div>
          <div className="semantic-confidence"><strong>{Math.round(profile.confidence * 100)}%</strong><span>신뢰도</span></div>
        </div>
        <div className="semantic-review-progress">
          <RagStep done active={!reviewDone} label="AI 분류" detail={profile.classificationLabel} number={1} />
          <ChevronRight size={16} />
          <RagStep done={reviewDone} active={!reviewDone} label="추천 승인" detail={reviewDone ? reviewMeta[profile.reviewState].label : "publish 권한 필요"} number={2} />
          <ChevronRight size={16} />
          <RagStep done={indexDone} active={indexBusy} label="문서 색인" detail={indexMeta[profile.indexStatus].label} number={3} />
        </div>
        <section className="semantic-rag-column-section">
          <div className="semantic-subsection-heading"><div><span className="semantic-section-label">INDEX CONFIGURATION</span><h4>검색에 사용할 컬럼</h4></div><small>Dataset 단위 설정</small></div>
          <div className="semantic-rag-columns">
            <RagColumnGroup columns={profile.textColumns} label="본문" role="text" />
            <RagColumnGroup columns={profile.titleColumns} label="문서 제목" role="title" />
            <RagColumnGroup columns={profile.filterColumns} label="필터" role="filter" />
            <RagColumnGroup columns={profile.excludedColumns} label="제외" role="exclude" />
          </div>
        </section>
        <section className="semantic-recommendation-list">
          <div className="semantic-subsection-heading"><div><span className="semantic-section-label">AI RECOMMENDATIONS</span><h4>추천 컬럼 역할</h4></div><small>승인 전 검토</small></div>
          {profile.recommendations.length ? profile.recommendations.map((recommendation) => <div className="semantic-recommendation-row" key={`${recommendation.column}-${recommendation.role}`}><div><code>{recommendation.column}</code><span>{ragRoleLabels[recommendation.role]}</span></div><div><strong>{Math.round(recommendation.confidence * 100)}%</strong><small>{recommendation.reason}</small></div></div>) : <p className="semantic-inline-empty">추천할 검색 컬럼이 없습니다.</p>}
        </section>
        <VectorDocumentPreview profile={profile} />
        <div className="semantic-rag-inspector-footer">
          <div><ShieldCheck size={15} /><span>승인과 색인에는 모델의 publish 권한과 Dataset query 권한이 모두 필요합니다.</span></div>
          {profile.reviewState !== "excluded" && <Button disabled={!canApprove || indexBusy} size="sm" type="button" onClick={() => onApproveAndIndex(profile)}>{indexBusy ? <><RefreshCw className="semantic-spin" /> {indexMeta[profile.indexStatus].label}</> : profile.indexStatus === "ready" ? <><RefreshCw /> 다시 색인</> : <><ShieldCheck /> 승인하고 색인</>}</Button>}
        </div>
      </div>
    </Card>
  );
}

function RagStep({ number, label, detail, active = false, done = false }: { number: number; label: string; detail: string; active?: boolean; done?: boolean }) {
  return <div className={`semantic-review-step${done ? " done" : ""}${active ? " active" : ""}`}><span>{done ? <Check size={12} /> : number}</span><div><strong>{label}</strong><small>{detail}</small></div></div>;
}

function RagColumnGroup({ label, columns, role }: { label: string; columns: string[]; role: "text" | "title" | "filter" | "exclude" }) {
  return <div><span className="semantic-column-label">{label}</span>{columns.length ? columns.map((column) => <RagColumnPill key={column} column={column} role={role} />) : <small>없음</small>}</div>;
}

function VectorDocumentPreview({ profile }: { profile: RagDatasetProfile }) {
  const embedding = embeddingMeta[profile.embeddingStatus];
  if (!profile.vectorDocuments.length) {
    return <div className="semantic-vector-empty"><Database size={19} /><div><strong>적재 문서 미리보기가 없습니다.</strong><span>{profile.reviewState === "excluded" ? "분석 전용 Dataset은 RAG 문서를 만들지 않습니다." : "승인 전에 실제 색인 규칙과 같은 형식으로 문서를 미리 봅니다."}</span></div></div>;
  }
  return (
    <section className="semantic-vector-preview">
      <div className="semantic-subsection-heading"><div><span className="semantic-section-label">DOCUMENT PREVIEW</span><h4>VectorDB 적재 문서 미리보기</h4><p>실제 임베딩 숫자 배열은 화면에 노출하지 않습니다.</p></div><Badge size="sm" variant={embedding.tone}>{embedding.label}</Badge></div>
      <div className="semantic-vector-summary"><div><span>문서 수</span><strong>{profile.documentCount}</strong></div><div><span>대상 인덱스</span><code>{profile.targetIndex}</code></div><div><span>최근 색인</span><strong>{profile.lastIndexedAt ?? "아직 없음"}</strong></div></div>
      <div className="semantic-vector-documents">{profile.vectorDocuments.slice(0, 2).map((document) => <article className="semantic-vector-document" key={document.documentId}><div className="semantic-vector-document-head"><code>{document.documentId}</code><Badge size="sm" variant={embeddingMeta[document.embeddingStatus].tone}>{embeddingMeta[document.embeddingStatus].label}</Badge></div><p>{document.body}</p><div className="semantic-vector-metadata">{Object.entries(document.metadata).map(([key, value]) => <span key={key}><code>{key}</code><strong>{value}</strong></span>)}</div><small>{document.sourceDataset}.{document.sourceColumn} → {document.targetIndex}</small></article>)}</div>
    </section>
  );
}

function QuestionsTab({ selected, onAskAssistant }: { selected: SemanticLayerModel; onAskAssistant: (prompt: string) => void }) {
  const [prompt, setPrompt] = useState(selected.questionExamples[0] ?? "");
  useEffect(() => { setPrompt(selected.questionExamples[0] ?? ""); }, [selected.id, selected.questionExamples]);
  const submit = () => { const value = prompt.trim(); if (value) onAskAssistant(value); };
  return (
    <div className="semantic-tab-content semantic-question-tab">
      <SectionHeading eyebrow="ASSISTANT TEST" title="통합 챗봇 질문 테스트" description="이 화면에서 답을 복제하지 않고, 선택한 업무 모델을 통합 챗봇 컨텍스트로 전달합니다." />
      <div className="semantic-question-layout">
        <Card className="semantic-question-guide" size="lg" variant="muted"><img src={askLakeNessiIconUrl} alt="" /><div><Badge size="sm" variant={selected.status === "published" ? "success" : "warning"}>{selected.status === "published" ? `게시됨 · v${selected.version}` : `초안 · v${selected.version}`}</Badge><h3>{selected.status === "published" ? "현재 게시 버전으로 질문합니다." : "챗봇은 게시된 버전만 사용합니다."}</h3><p>현재 Draft의 변경 내용은 게시 전까지 질문 결과에 반영되지 않습니다.</p></div></Card>
        <Card className="semantic-question-composer" size="none"><div className="semantic-question-suggestions"><span>추천 질문</span>{selected.questionExamples.length ? selected.questionExamples.map((question) => <button key={question} type="button" onClick={() => setPrompt(question)}>{question}</button>) : <small>모델 정보에 대표 질문을 추가해 주세요.</small>}</div><Textarea rows={5} value={prompt} placeholder="업무 모델에 질문할 내용을 입력하세요." onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") submit(); }} /><div className="semantic-question-submit"><span>⌘/Ctrl + Enter</span><Button disabled={!prompt.trim()} type="button" onClick={submit}><Bot /> 통합 챗봇에서 테스트</Button></div></Card>
      </div>
    </div>
  );
}

function AccessTab({ selected, onAdd, onUpdate, onDelete }: { selected: SemanticLayerModel; onAdd: () => void; onUpdate: (grantId: string, action: SemanticPermissionAction, checked: boolean) => void; onDelete: (id: string) => void }) {
  return (
    <div className="semantic-tab-content semantic-access-page">
      <SectionHeading eyebrow="MODEL ACCESS" title="권한" description="업무 모델의 보기·질의·관리·게시 권한을 주체별로 관리합니다." actions={<Button size="sm" type="button" variant="outline" onClick={onAdd}><Plus /> 권한 규칙 추가</Button>} />
      <Card className="semantic-access-panel" size="none">
        <div className="semantic-access-notice"><ShieldCheck size={16} /><span>화면 제어는 보조 UX이며, 실제 요청마다 서버가 모델 권한과 Dataset query 권한을 다시 확인합니다.</span></div>
        <div className="semantic-access-table-head"><span>주체</span><span>권한</span><span /></div>
        {selected.permissionGrants.length ? selected.permissionGrants.map((grant) => <div className="semantic-access-row" key={grant.id}><div className="semantic-access-principal"><span>{grant.principalType === "group" ? <Boxes size={16} /> : grant.principalType === "public" ? <ShieldCheck size={16} /> : <CircleUser size={16} />}</span><div><strong>{principalLabel(grant.principalId)}</strong><small>{grant.principalType === "group" ? "그룹" : grant.principalType === "public" ? "전체" : "사용자"}</small></div></div><div className="semantic-access-actions">{accessActions.map((action) => { const checked = grant.actions.includes(action); return <label className={checked ? "semantic-access-toggle checked" : "semantic-access-toggle"} key={action}><input checked={checked} type="checkbox" onChange={(event) => onUpdate(grant.id ?? "", action, event.target.checked)} /><span>{accessActionLabels[action]}</span></label>; })}</div><Button aria-label={`${principalLabel(grant.principalId)} 권한 삭제`} size="iconSm" type="button" variant="ghost" onClick={() => onDelete(grant.id ?? "")}><Trash2 size={15} /></Button></div>) : <EmptyState icon={<ShieldCheck size={22} />} title="권한 규칙이 없습니다." description="권한 규칙을 추가해야 이 모델을 사용할 수 있습니다." />}
      </Card>
    </div>
  );
}

function EmptyState({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
  return <div className="semantic-empty-state">{icon}<strong>{title}</strong><span>{description}</span></div>;
}
