import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, Check, Database, FileText, Loader2, Plus, RefreshCw, Save, Search, ShieldCheck, Sparkles, Trash2, X } from "lucide-react";
import type { CatalogDataset } from "../../types";
import type { AuditResult } from "../../types/audit";
import { apiClient } from "../../services/apiClient";
import {
  approveRagDataset,
  classifyRagDataset,
  createSemanticModel,
  getRagProfile,
  indexRagDataset,
  listSemanticModels,
  previewRagDocuments,
  publishSemanticModel,
  replaceSemanticDimensions,
  replaceSemanticMetrics,
  replaceSemanticDatasets,
  searchRagDataset,
  updateSemanticModel,
  validateSemanticModel,
  type RagDocument,
  type RagProfile,
  type RagSearchResponse,
  type SemanticDataset,
  type SemanticDimension,
  type SemanticMetric,
  type SemanticModel,
  type SemanticSchemaColumn,
} from "../../services/semanticApi";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { RagJobHistory } from "../../components/semantic/RagJobHistory";
import { RagServingStatus } from "../../components/semantic/RagServingStatus";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import "../../styles/semantic-layer-real.css";

type Tab = "datasets" | "analysis" | "rag" | "access";
type Notice = { tone: "success" | "error" | "info"; message: string };
type RagRolePayload = Pick<RagProfile, "bodyColumns" | "titleColumns" | "metadataColumns" | "identifierColumns" | "excludedColumns">;

type SemanticPageProps = {
  datasets: CatalogDataset[];
  onAction?: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
};

function catalogDatasetList(value: { datasets?: CatalogDataset[] } | CatalogDataset[]): CatalogDataset[] {
  return Array.isArray(value) ? value : value.datasets ?? [];
}

function schemaFor(dataset: SemanticDataset | undefined, catalog: CatalogDataset[]): SemanticSchemaColumn[] {
  if (dataset?.schema?.length) return dataset.schema;
  const source = catalog.find((item) => item.id === dataset?.datasetId);
  return source?.schema.map(([name, dataType]) => ({ name, dataType, description: "", sampleValues: [] })) ?? [];
}

function modelDataset(model: SemanticModel, datasetId: string | null | undefined) {
  return model.datasets.find((item) => item.datasetId === datasetId) ?? model.datasets[0];
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    draft: "초안",
    published: "게시됨",
    not_configured: "분석 전",
    classifying: "분류 중",
    candidate: "승인 대기",
    needs_review: "검토 필요",
    approved: "승인됨",
    excluded: "RAG 제외",
    not_indexed: "색인 전",
    queued: "색인 대기",
    indexing: "색인 중",
    ready: "검색 가능",
    serving: "검색 가능",
    stale: "재색인 필요",
    not_serving: "검색 불가",
    failed: "실패",
    no_matches: "검색 결과 없음",
    no_relevant_evidence: "관련 근거 없음",
    query_planning_unavailable: "검색 계획 실패",
    relevance_unavailable: "관련성 검증 실패",
    degraded: "일부 검색만 사용",
    degraded_no_matches: "임베딩 검색 저하 · 결과 없음",
  };
  return labels[status] ?? status;
}

function semanticModelDisplayVersion(model: SemanticModel) {
  return model.status === "published" && model.publishedVersion != null
    ? model.publishedVersion
    : model.version;
}

function roleLabel(role: string) {
  return ({ body: "본문", title: "문서 제목", metadata: "필터 메타데이터", identifier: "문서 식별자", excluded: "제외" } as Record<string, string>)[role] ?? role;
}

function schemaColumnLabel(column: SemanticSchemaColumn) {
  return `${column.name} · ${column.dataType}`;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
}

export function SemanticLayerPage({ onAction }: SemanticPageProps) {
  const [models, setModels] = useState<SemanticModel[]>([]);
  const [catalogDatasets, setCatalogDatasets] = useState<CatalogDataset[]>([]);
  const [selectedModelId, setSelectedModelId] = useState("");
  const [activeTab, setActiveTab] = useState<Tab>("datasets");
  const [selectedRagDatasetId, setSelectedRagDatasetId] = useState("");
  const [profiles, setProfiles] = useState<Record<string, RagProfile>>({});
  const [previews, setPreviews] = useState<Record<string, RagDocument[]>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [ragJobsRefreshToken, setRagJobsRefreshToken] = useState(0);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextModels, catalogResponse] = await Promise.all([
        listSemanticModels(),
        apiClient.get<{ datasets: CatalogDataset[] } | CatalogDataset[]>("/api/catalog/datasets"),
      ]);
      const nextCatalog = catalogDatasetList(catalogResponse);
      setModels(nextModels);
      setCatalogDatasets(nextCatalog);
      setProfiles({});
      setPreviews({});
      setSelectedModelId((current) => current && nextModels.some((model) => model.id === current) ? current : nextModels[0]?.id ?? "");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Semantic Model과 Catalog를 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const selected = models.find((model) => model.id === selectedModelId) ?? models[0];
  const linkedCatalog = useMemo(
    () => selected?.datasets.map((item) => catalogDatasets.find((dataset) => dataset.id === item.datasetId)).filter(Boolean) as CatalogDataset[] ?? [],
    [catalogDatasets, selected],
  );
  const ragDatasetId = selectedRagDatasetId || selected?.datasets[0]?.datasetId || "";
  const ragProfile = profiles[ragDatasetId];

  useEffect(() => {
    if (!selected) return;
    setSelectedRagDatasetId((current) => selected.datasets.some((item) => item.datasetId === current) ? current : selected.datasets[0]?.datasetId ?? "");
  }, [selected]);

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setNotice(null);
    try {
      await action();
    } catch (actionError) {
      setNotice({ tone: "error", message: actionError instanceof Error ? actionError.message : "요청을 처리하지 못했습니다." });
    } finally {
      setBusy(null);
    }
  };

  const refreshProfile = async (datasetId: string) => {
    const profile = await getRagProfile(datasetId);
    setProfiles((current) => ({ ...current, [datasetId]: profile }));
    if (profile.reviewState === "approved") {
      const preview = await previewRagDocuments(datasetId);
      setPreviews((current) => ({ ...current, [datasetId]: preview.documents }));
    }
  };

  useEffect(() => {
    if (!ragDatasetId || activeTab !== "rag" || profiles[ragDatasetId]) return;
    void run(`profile:${ragDatasetId}`, async () => refreshProfile(ragDatasetId));
  }, [activeTab, ragDatasetId, profiles]);

  const saveModelInfo = async (name: string, description: string) => {
    if (!selected) return;
    await run("model", async () => {
      const updated = await updateSemanticModel(selected.id, { name, description });
      setModels((current) => current.map((model) => model.id === updated.id ? updated : model));
      setNotice({ tone: "success", message: "업무 모델 정보가 저장되었습니다." });
      onAction?.("semantic.model.updated", `/api/semantic-models/${selected.id}`, selected.id, "success");
    });
  };

  const saveDatasets = async (nextDatasets: SemanticDataset[]) => {
    if (!selected) return;
    await run("datasets", async () => {
      const updated = await replaceSemanticDatasets(selected.id, nextDatasets.map((item) => ({ datasetId: item.datasetId, role: item.role })));
      setModels((current) => current.map((model) => model.id === updated.id ? updated : model));
      setNotice({ tone: "success", message: "연결 Dataset과 전체 schema가 갱신되었습니다." });
    });
  };

  const saveMetrics = async (metrics: SemanticMetric[]) => {
    if (!selected) return;
    await run("metrics", async () => {
      const updated = await replaceSemanticMetrics(selected.id, metrics.map(({ id: _id, ...metric }) => metric));
      setModels((current) => current.map((model) => model.id === updated.id ? updated : model));
      setNotice({ tone: "success", message: "지표와 물리 컬럼 바인딩이 저장되었습니다." });
    });
  };

  const saveDimensions = async (dimensions: SemanticDimension[]) => {
    if (!selected) return;
    await run("dimensions", async () => {
      const updated = await replaceSemanticDimensions(selected.id, dimensions.map(({ id: _id, ...dimension }) => dimension));
      setModels((current) => current.map((model) => model.id === updated.id ? updated : model));
      setNotice({ tone: "success", message: "분석 기준과 실제 schema 컬럼이 저장되었습니다." });
    });
  };

  const classify = async () => {
    if (!selected || !ragDatasetId) return;
    await run("classify", async () => {
      await classifyRagDataset(ragDatasetId, selected.id);
      await refreshProfile(ragDatasetId);
      setNotice({ tone: "success", message: "선택한 Semantic Model의 지표·분석 기준을 포함해 RAG 컬럼 분석을 완료했습니다." });
      onAction?.("semantic.rag.classified", `/api/catalog/datasets/${ragDatasetId}/rag/classify`, ragDatasetId, "success");
    });
  };

  const approve = async (roles: RagRolePayload) => {
    if (!ragDatasetId) return;
    await run("approve", async () => {
      const profile = await approveRagDataset(ragDatasetId, roles);
      setProfiles((current) => ({ ...current, [ragDatasetId]: profile }));
      const preview = await previewRagDocuments(ragDatasetId);
      setPreviews((current) => ({ ...current, [ragDatasetId]: preview.documents }));
      setNotice({ tone: "success", message: "RAG 역할을 승인했고 실제 적재 문서 미리보기를 생성했습니다." });
    });
  };

  const index = async () => {
    if (!ragDatasetId) return;
    await run("index", async () => {
      const hasServingIndex = ragProfile?.servingStatus === "serving" || ragProfile?.servingStatus === "stale";
      const accepted = await indexRagDataset(ragDatasetId, hasServingIndex ? "reindex" : "index");
      setRagJobsRefreshToken((current) => current + 1);
      if (accepted.status === "ready") {
        await refreshProfile(ragDatasetId);
        setNotice({ tone: "success", message: "현재 Dataset과 RAG 정의에 맞는 활성 색인을 확인했습니다. 실제 근거 검색을 바로 사용할 수 있습니다." });
        return;
      }
      let latest: RagProfile | null = null;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await delay(1000);
        latest = await getRagProfile(ragDatasetId);
        setProfiles((current) => ({ ...current, [ragDatasetId]: latest as RagProfile }));
        if (latest.indexStatus === "failed" || latest.buildStatus === "failed") {
          throw new Error(latest.lastError || `RAG 색인 작업 ${accepted.jobId}가 실패했습니다.`);
        }
        const requestedIndexIsServing = latest.servingStatus === "serving"
          && (accepted.targetIndex ? latest.activeIndex === accepted.targetIndex : latest.buildStatus === "ready");
        if (requestedIndexIsServing) break;
      }
      const requestedIndexIsServing = latest?.servingStatus === "serving"
        && (accepted.targetIndex ? latest.activeIndex === accepted.targetIndex : latest.buildStatus === "ready");
      if (!latest || !requestedIndexIsServing) {
        setNotice({ tone: "info", message: `RAG 색인 작업 ${accepted.jobId}를 접수했습니다. 백그라운드 작업이 끝나면 근거 검색이 활성화됩니다.` });
        return;
      }
      const preview = await previewRagDocuments(ragDatasetId);
      setPreviews((current) => ({ ...current, [ragDatasetId]: preview.documents }));
      setNotice({ tone: "success", message: "RAG 색인과 Semantic Model 연결이 완료되어 근거 검색을 사용할 수 있습니다." });
    });
  };

  if (loading) return <div className="semantic-real-loading" role="status"><Loader2 className="semantic-spin" /> 실제 Semantic Model과 Catalog schema를 불러오는 중입니다.</div>;
  if (error) return <div className="semantic-real-error" role="alert"><AlertTriangle /><div><strong>실제 백엔드 연결이 필요합니다.</strong><p>{error}</p><Button type="button" onClick={() => void load()}><RefreshCw /> 다시 시도</Button></div></div>;

  return (
    <section className="semantic-real-page" aria-label="실제 시맨틱 레이어 관리">
      {notice && <div className={`semantic-real-notice ${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>{notice.message}<button type="button" aria-label="알림 닫기" onClick={() => setNotice(null)}><X size={15} /></button></div>}
      <div className="semantic-real-toolbar">
        <div><span className="semantic-real-eyebrow">CATALOG / 시맨틱 레이어</span><h1>시맨틱 레이어</h1><p>Catalog의 실제 schema를 선택해 지표·분석 기준과 RAG 문서를 연결합니다.</p></div>
        <div className="semantic-real-toolbar-actions"><Button variant="outline" type="button" onClick={() => void load()}><RefreshCw /> 새로고침</Button><Button type="button" onClick={() => setCreateOpen(true)}><Plus /> 업무 모델 추가</Button></div>
      </div>
      {createOpen && <CreateModelPanel datasets={catalogDatasets} busy={busy === "create"} onCancel={() => setCreateOpen(false)} onCreate={(name, description, datasetIds) => void run("create", async () => { const created = await createSemanticModel({ name, description, datasets: datasetIds.map((datasetId) => ({ datasetId, role: "source" as const })) }); setModels((current) => [created, ...current]); setSelectedModelId(created.id); setCreateOpen(false); setNotice({ tone: "success", message: "실제 데이터베이스에 업무 모델을 생성했습니다." }); })} />}
      {!selected ? <EmptyModelState onCreate={() => setCreateOpen(true)} /> : <>
        <div className="semantic-real-model-layout">
          <aside className="semantic-real-model-list" aria-label="업무 모델 목록">
            <div className="semantic-real-list-heading"><strong>업무 모델</strong><span>{models.length}개</span></div>
            {models.map((model) => <button type="button" key={model.id} className={model.id === selected.id ? "active" : ""} onClick={() => setSelectedModelId(model.id)}><span className="semantic-real-model-dot" /><span><strong>{model.name}</strong><small>{statusLabel(model.status)} · v{semanticModelDisplayVersion(model)}</small></span></button>)}
          </aside>
          <main className="semantic-real-editor">
            <ModelHeader model={selected} busy={busy === "model"} onSave={saveModelInfo} onValidate={() => void run("validate", async () => { const result = await validateSemanticModel(selected.id); setNotice({ tone: result.valid ? "success" : "error", message: result.valid ? "게시 검증을 통과했습니다." : result.errors.join(" / ") }); })} onPublish={() => void run("publish", async () => { const result = await publishSemanticModel(selected.id); setModels((current) => current.map((model) => model.id === result.model.id ? result.model : model)); setNotice({ tone: "success", message: `업무 모델 v${result.publishedVersion}를 게시했습니다.` }); })} />
            <nav className="semantic-real-tabs" aria-label="업무 모델 편집 탭">{([ ["datasets", "데이터 연결"], ["analysis", "분석 기준"], ["rag", "RAG 검색"], ["access", "접근 권한"]] as Array<[Tab, string]>).map(([id, label]) => <button type="button" key={id} className={activeTab === id ? "active" : ""} onClick={() => setActiveTab(id)}>{label}{id === "datasets" && <em>{selected.datasets.length}</em>}{id === "analysis" && <em>{selected.metrics.length + selected.dimensions.length}</em>}{id === "rag" && <em>{Object.values(profiles).filter((profile) => profile.servingStatus === "serving").length}</em>}</button>)}</nav>
            {activeTab === "datasets" && <DatasetsTab model={selected} catalogDatasets={catalogDatasets} onSave={saveDatasets} />}
            {activeTab === "analysis" && <AnalysisDefinitionsTab model={selected} catalogDatasets={catalogDatasets} onSaveMetrics={saveMetrics} onSaveDimensions={saveDimensions} />}
            {activeTab === "rag" && <><RagServingStatus profile={ragProfile} /><RagTab model={selected} selectedDatasetId={ragDatasetId} profile={ragProfile} previewDocuments={previews[ragDatasetId] ?? []} jobsRefreshToken={ragJobsRefreshToken} onDatasetChange={setSelectedRagDatasetId} onRefresh={() => void run("profile", async () => refreshProfile(ragDatasetId))} onClassify={classify} onApprove={approve} onIndex={index} busy={busy} /></>}
            {activeTab === "access" && <AccessTab model={selected} />}
          </main>
        </div>
      </>}
    </section>
  );
}

function ModelHeader({ model, busy, onSave, onValidate, onPublish }: { model: SemanticModel; busy: boolean; onSave: (name: string, description: string) => Promise<void>; onValidate: () => void; onPublish: () => void }) {
  const [name, setName] = useState(model.name);
  const [description, setDescription] = useState(model.description);
  useEffect(() => { setName(model.name); setDescription(model.description); }, [model.id, model.name, model.description]);
  return <div className="semantic-real-model-header"><div><span className="semantic-real-eyebrow">{statusLabel(model.status)} · v{semanticModelDisplayVersion(model)} · 소유자 {model.owner}</span><Input value={name} onChange={(event) => setName(event.target.value)} aria-label="업무 모델 이름" /><Textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={2} aria-label="업무 모델 설명" /></div><div className="semantic-real-header-actions"><span className="semantic-real-save-state">실제 DB 저장</span><Button variant="outline" disabled={busy} type="button" onClick={() => void onSave(name.trim(), description)}><Save /> 저장</Button><Button variant="outline" type="button" onClick={onValidate}><ShieldCheck /> 검증</Button><Button type="button" onClick={onPublish}><Check /> 게시</Button></div></div>;
}

function DatasetsTab({ model, catalogDatasets, onSave }: { model: SemanticModel; catalogDatasets: CatalogDataset[]; onSave: (datasets: SemanticDataset[]) => Promise<void> }) {
  const [datasets, setDatasets] = useState(model.datasets);
  useEffect(() => setDatasets(model.datasets), [model.id, model.datasets]);
  const toggle = (datasetId: string) => setDatasets((current) => current.some((item) => item.datasetId === datasetId) ? current.filter((item) => item.datasetId !== datasetId) : [...current, { id: `draft-${datasetId}`, datasetId, role: "source", joinConfig: {}, schema: [], description: "" }]);
  return <div className="semantic-real-tab-content"><SectionTitle eyebrow="CONNECTED DATASETS" title="사용 Dataset과 전체 schema" description="실제 Catalog Dataset만 연결할 수 있으며, 연결한 Dataset의 모든 컬럼을 확인합니다." action={<Button type="button" onClick={() => void onSave(datasets)}><Save /> 연결 저장</Button>} /><div className="semantic-real-dataset-picker">{catalogDatasets.map((dataset) => { const connected = datasets.some((item) => item.datasetId === dataset.id); return <label key={dataset.id} className={connected ? "selected" : ""}><input type="checkbox" checked={connected} onChange={() => toggle(dataset.id)} /><Database size={16} /><span><strong>{dataset.name}</strong><small>{dataset.layer} · {dataset.rows} · {dataset.schema.length}개 컬럼</small></span></label>; })}</div><div className="semantic-real-schema-grid">{datasets.map((dataset) => <SchemaCard key={dataset.datasetId} dataset={dataset} catalogDatasets={catalogDatasets} />)}</div></div>;
}

function SchemaCard({ dataset, catalogDatasets }: { dataset: SemanticDataset; catalogDatasets: CatalogDataset[] }) {
  const schema = schemaFor(dataset, catalogDatasets);
  return <Card className="semantic-real-schema-card" size="none"><div className="semantic-real-card-heading"><div><span className="semantic-real-eyebrow">{dataset.layer ?? "CATALOG"} · {dataset.rows ?? "행 수 미상"}</span><h3>{dataset.name ?? dataset.datasetId}</h3><p>{dataset.description || "Catalog Dataset schema"}</p></div><code>{dataset.schemaFingerprint?.slice(0, 12) ?? "schema"}</code></div><div className="semantic-real-schema-table"><div className="header"><span>컬럼</span><span>타입</span><span>샘플</span></div>{schema.map((column) => <div key={column.name}><code>{column.name}</code><span>{column.dataType}</span><small>{column.sampleValues.slice(0, 2).join(" · ") || "샘플 없음"}</small></div>)}</div></Card>;
}

function draftDefinitionId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function technicalName(value: string, fallback: string) {
  const normalized = value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  return normalized || fallback;
}

function uniqueDefinitionName(base: string, existingNames: string[]) {
  const names = new Set(existingNames);
  if (!names.has(base)) return base;
  let suffix = 2;
  while (names.has(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
}

function isNumericSemanticType(dataType: string) {
  return /(^|\b)(tinyint|smallint|int|integer|bigint|float|double|decimal|numeric|number|real)(\b|\()/i.test(dataType);
}

function quoteSemanticColumn(columnName: string) {
  return `"${columnName.replace(/"/g, '""')}"`;
}

function firstDefinitionColumn(
  model: SemanticModel,
  catalogDatasets: CatalogDataset[],
  usedColumns: Set<string>,
  predicate: (column: SemanticSchemaColumn) => boolean = () => true,
) {
  for (const dataset of model.datasets) {
    const column = schemaFor(dataset, catalogDatasets)
      .find((item) => predicate(item) && !usedColumns.has(`${dataset.datasetId}:${item.name}`));
    if (column) return { dataset, column };
  }
  return null;
}

function AnalysisDefinitionsTab({ model, catalogDatasets, onSaveMetrics, onSaveDimensions }: {
  model: SemanticModel;
  catalogDatasets: CatalogDataset[];
  onSaveMetrics: (metrics: SemanticMetric[]) => Promise<void>;
  onSaveDimensions: (dimensions: SemanticDimension[]) => Promise<void>;
}) {
  return (
    <div className="semantic-real-tab-content">
      <Card size="none" className="semantic-real-analysis-guide">
        <div>
          <span className="semantic-real-eyebrow">ANALYSIS DEFINITIONS</span>
          <h2>무엇을 계산하고, 어떤 기준으로 나눠볼지 정합니다.</h2>
          <p><strong>계산할 값</strong>은 매출 합계·평균 평점처럼 숫자로 계산할 항목이고, <strong>나눠볼 기준</strong>은 상품·카테고리·날짜처럼 결과를 묶거나 필터링할 항목입니다.</p>
        </div>
        <div className="semantic-real-analysis-counts">
          <span><strong>{model.metrics.length}</strong>개 계산 값</span>
          <span><strong>{model.dimensions.length}</strong>개 나눠볼 기준</span>
        </div>
      </Card>
      <MetricsSection model={model} catalogDatasets={catalogDatasets} onSave={onSaveMetrics} />
      <DimensionsSection model={model} catalogDatasets={catalogDatasets} onSave={onSaveDimensions} />
    </div>
  );
}

function MetricsSection({ model, catalogDatasets, onSave }: { model: SemanticModel; catalogDatasets: CatalogDataset[]; onSave: (metrics: SemanticMetric[]) => Promise<void> }) {
  const [metrics, setMetrics] = useState(model.metrics);
  useEffect(() => setMetrics(model.metrics), [model.id, model.metrics]);
  const update = (id: string, patch: Partial<SemanticMetric>) => setMetrics((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  const add = () => {
    const usedColumns = new Set(metrics.flatMap((item) => item.sourceColumns.map((column) => `${item.datasetId}:${column}`)));
    const candidate = firstDefinitionColumn(model, catalogDatasets, usedColumns, (column) => isNumericSemanticType(column.dataType));
    const baseName = candidate ? technicalName(`${candidate.column.name}_sum`, "calculated_value") : "row_count";
    const name = uniqueDefinitionName(baseName, metrics.map((item) => item.name));
    setMetrics((current) => [...current, {
      id: draftDefinitionId("metric"),
      name,
      label: candidate ? `${candidate.column.name} 합계` : "행 개수",
      description: candidate ? `${candidate.column.name} 컬럼의 합계입니다.` : "Dataset의 전체 행 개수입니다.",
      expression: candidate ? `SUM(${quoteSemanticColumn(candidate.column.name)})` : "COUNT(*)",
      datasetId: candidate?.dataset.datasetId ?? model.datasets[0]?.datasetId ?? null,
      sourceColumns: candidate ? [candidate.column.name] : [],
      format: null,
    }]);
  };
  const remove = (id: string) => setMetrics((current) => current.filter((item) => item.id !== id));
  return (
    <section className="semantic-real-definition-section" aria-labelledby="semantic-calculated-values-title">
      <SectionTitle
        eyebrow="CALCULATED VALUES"
        title="계산할 값"
        titleId="semantic-calculated-values-title"
        description="예: 상품 가격 합계, 평균 평점, 전체 상품 수. 실제 Catalog 컬럼과 계산식을 함께 저장합니다."
        action={<div className="semantic-real-definition-actions"><Button variant="outline" type="button" onClick={add}><Plus /> 계산 값 추가</Button><Button type="button" onClick={() => void onSave(metrics)}><Save /> 계산 값 저장</Button></div>}
      />
      {metrics.length === 0 ? <DefinitionEmptyState title="아직 계산할 값이 없습니다." description="계산 값 추가를 누르면 연결된 Dataset의 숫자 컬럼으로 실제 항목을 만들 수 있습니다." onAdd={add} buttonLabel="첫 계산 값 추가" /> : <div className="semantic-real-definition-list">{metrics.map((metric) => <Card key={metric.id} className="semantic-real-definition-card" size="none">
        <div className="semantic-real-definition-card-header"><strong>{metric.label || "이름 없는 계산 값"}</strong><Button variant="ghost" type="button" aria-label={`${metric.label || metric.name} 삭제`} onClick={() => remove(metric.id)}><Trash2 /> 삭제</Button></div>
        <div className="semantic-real-definition-main">
          <label>화면에 보일 이름<Input value={metric.label} onChange={(event) => update(metric.id, { label: event.target.value })} aria-label={`${metric.name} 표시명`} /></label>
          <label>내부 이름<Input value={metric.name} onChange={(event) => update(metric.id, { name: technicalName(event.target.value, metric.name) })} aria-label={`${metric.name} 내부 이름`} /></label>
          <label>계산식<Input value={metric.expression} onChange={(event) => update(metric.id, { expression: event.target.value })} aria-label={`${metric.name} 계산식`} /></label>
        </div>
        <PhysicalColumnPicker model={model} catalogDatasets={catalogDatasets} datasetId={metric.datasetId ?? ""} selectedColumns={metric.sourceColumns} onDatasetChange={(datasetId) => update(metric.id, { datasetId, sourceColumns: [] })} onColumnsChange={(sourceColumns) => update(metric.id, { sourceColumns })} />
      </Card>)}</div>}
    </section>
  );
}

function DimensionsSection({ model, catalogDatasets, onSave }: { model: SemanticModel; catalogDatasets: CatalogDataset[]; onSave: (dimensions: SemanticDimension[]) => Promise<void> }) {
  const [dimensions, setDimensions] = useState(model.dimensions);
  useEffect(() => setDimensions(model.dimensions), [model.id, model.dimensions]);
  const update = (id: string, patch: Partial<SemanticDimension>) => setDimensions((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  const add = () => {
    const usedColumns = new Set(dimensions.map((item) => `${item.datasetId}:${item.columnName}`));
    const candidate = firstDefinitionColumn(model, catalogDatasets, usedColumns);
    if (!candidate) return;
    const name = uniqueDefinitionName(technicalName(candidate.column.name, "grouping_field"), dimensions.map((item) => item.name));
    setDimensions((current) => [...current, {
      id: draftDefinitionId("dimension"),
      name,
      label: candidate.column.name,
      description: `${candidate.dataset.name ?? candidate.dataset.datasetId}의 ${candidate.column.name} 컬럼으로 결과를 나눕니다.`,
      datasetId: candidate.dataset.datasetId,
      columnName: candidate.column.name,
      dataType: candidate.column.dataType,
    }]);
  };
  const remove = (id: string) => setDimensions((current) => current.filter((item) => item.id !== id));
  const hasAvailableColumn = Boolean(firstDefinitionColumn(
    model,
    catalogDatasets,
    new Set(dimensions.map((item) => `${item.datasetId}:${item.columnName}`)),
  ));
  return (
    <section className="semantic-real-definition-section" aria-labelledby="semantic-grouping-fields-title">
      <SectionTitle
        eyebrow="GROUPING AND FILTERING"
        title="나눠볼 기준"
        titleId="semantic-grouping-fields-title"
        description="예: 상품명별, 카테고리별, 등록일별. 그룹·필터에 사용할 실제 Catalog 컬럼을 연결합니다."
        action={<div className="semantic-real-definition-actions"><Button variant="outline" type="button" disabled={!hasAvailableColumn} onClick={add}><Plus /> 기준 추가</Button><Button type="button" onClick={() => void onSave(dimensions)}><Save /> 기준 저장</Button></div>}
      />
      {dimensions.length === 0 ? <DefinitionEmptyState title="아직 나눠볼 기준이 없습니다." description={hasAvailableColumn ? "기준 추가를 누르면 실제 Catalog 컬럼이 연결된 항목을 만듭니다." : "먼저 데이터 연결 탭에서 schema가 있는 Dataset을 연결하세요."} onAdd={add} buttonLabel="첫 기준 추가" disabled={!hasAvailableColumn} /> : <div className="semantic-real-definition-list">{dimensions.map((dimension) => <Card key={dimension.id} className="semantic-real-definition-card" size="none">
        <div className="semantic-real-definition-card-header"><strong>{dimension.label || "이름 없는 기준"}</strong><Button variant="ghost" type="button" aria-label={`${dimension.label || dimension.name} 삭제`} onClick={() => remove(dimension.id)}><Trash2 /> 삭제</Button></div>
        <div className="semantic-real-definition-main">
          <label>화면에 보일 이름<Input value={dimension.label} onChange={(event) => update(dimension.id, { label: event.target.value })} aria-label={`${dimension.name} 표시명`} /></label>
          <label>내부 이름<Input value={dimension.name} onChange={(event) => update(dimension.id, { name: technicalName(event.target.value, dimension.name) })} aria-label={`${dimension.name} 내부 이름`} /></label>
          <label>설명<Input value={dimension.description} onChange={(event) => update(dimension.id, { description: event.target.value })} aria-label={`${dimension.name} 설명`} /></label>
        </div>
        <PhysicalColumnPicker model={model} catalogDatasets={catalogDatasets} datasetId={dimension.datasetId ?? ""} selectedColumns={dimension.columnName ? [dimension.columnName] : []} single inputName={`dimension-schema-${dimension.id}`} onDatasetChange={(datasetId) => update(dimension.id, { datasetId, columnName: "", dataType: "" })} onColumnsChange={(columns) => { const column = schemaFor(modelDataset(model, dimension.datasetId), catalogDatasets).find((item) => item.name === columns[0]); update(dimension.id, { columnName: columns[0] ?? "", dataType: column?.dataType ?? "" }); }} />
      </Card>)}</div>}
    </section>
  );
}

function DefinitionEmptyState({ title, description, onAdd, buttonLabel, disabled = false }: { title: string; description: string; onAdd: () => void; buttonLabel: string; disabled?: boolean }) {
  return <Card size="none" className="semantic-real-definition-empty"><Plus /><strong>{title}</strong><p>{description}</p><Button variant="outline" type="button" disabled={disabled} onClick={onAdd}><Plus /> {buttonLabel}</Button></Card>;
}

function PhysicalColumnPicker({ model, catalogDatasets, datasetId, selectedColumns, single = false, inputName, onDatasetChange, onColumnsChange }: { model: SemanticModel; catalogDatasets: CatalogDataset[]; datasetId: string; selectedColumns: string[]; single?: boolean; inputName?: string; onDatasetChange: (datasetId: string) => void; onColumnsChange: (columns: string[]) => void }) {
  const dataset = modelDataset(model, datasetId);
  const schema = schemaFor(dataset, catalogDatasets);
  return <div className="semantic-real-binding"><label>원본 Dataset<select value={datasetId} onChange={(event) => onDatasetChange(event.target.value)}><option value="">선택하세요</option>{model.datasets.map((item) => <option key={item.datasetId} value={item.datasetId}>{item.name ?? item.datasetId}</option>)}</select></label><div><span>실제 schema 컬럼</span><div className="semantic-real-column-options">{schema.map((column) => <label key={column.name}><input type={single ? "radio" : "checkbox"} name={single ? inputName ?? `schema-${datasetId}` : undefined} checked={selectedColumns.includes(column.name)} onChange={(event) => onColumnsChange(single ? [column.name] : event.target.checked ? [...selectedColumns, column.name] : selectedColumns.filter((item) => item !== column.name))} /><code>{schemaColumnLabel(column)}</code></label>)}</div></div></div>;
}

function RagTab({ model, selectedDatasetId, profile, previewDocuments, jobsRefreshToken, onDatasetChange, onRefresh, onClassify, onApprove, onIndex, busy }: { model: SemanticModel; selectedDatasetId: string; profile?: RagProfile; previewDocuments: RagDocument[]; jobsRefreshToken: number; onDatasetChange: (id: string) => void; onRefresh: () => void; onClassify: () => void; onApprove: (roles: RagRolePayload) => void; onIndex: () => void; busy: string | null }) {
  const [roles, setRoles] = useState<Record<string, string>>({});
  const [embeddedColumns, setEmbeddedColumns] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!profile) return;
    const next: Record<string, string> = {};
    const nextEmbedded: Record<string, boolean> = {};
    profile.bodyColumns.forEach((column) => { next[column] = "body"; });
    profile.titleColumns.forEach((column) => { next[column] = "title"; });
    profile.metadataColumns.forEach((column) => { next[column] = "metadata"; });
    profile.identifierColumns.forEach((column) => { next[column] = "identifier"; });
    profile.excludedColumns.forEach((column) => { next[column] = "excluded"; });
    profile.recommendations.forEach((item) => { if (!next[item.columnName]) next[item.columnName] = item.role; });
    [...profile.bodyColumns, ...profile.titleColumns].forEach((column) => { nextEmbedded[column] = true; });
    setRoles(next);
    setEmbeddedColumns(nextEmbedded);
  }, [profile]);
  const schema = profile?.schema ?? modelDataset(model, selectedDatasetId)?.schema ?? [];
  const selectRole = (column: string, role: string) => {
    setRoles((current) => ({ ...current, [column]: role }));
    setEmbeddedColumns((current) => ({
      ...current,
      [column]: role === "body" || role === "title" ? true : role === "excluded" ? false : Boolean(current[column]),
    }));
  };
  const includeWholeDocument = () => setEmbeddedColumns(Object.fromEntries(
    schema.map((column) => [column.name, roles[column.name] !== "excluded"]),
  ));
  const approveWithRoles = () => {
    if (!profile) return;
    onApprove({
      bodyColumns: schema.filter((column) => {
        const role = roles[column.name];
        return role === "body" || (embeddedColumns[column.name] && role !== "title" && role !== "excluded");
      }).map((column) => column.name),
      titleColumns: schema.filter((column) => roles[column.name] === "title").map((column) => column.name),
      metadataColumns: schema.filter((column) => roles[column.name] === "metadata").map((column) => column.name),
      identifierColumns: schema.filter((column) => roles[column.name] === "identifier").map((column) => column.name),
      excludedColumns: schema.filter((column) => roles[column.name] === "excluded").map((column) => column.name),
    });
  };
  const hasServingIndex = profile?.servingStatus === "serving" || profile?.servingStatus === "stale";
  const hasEmbeddingBody = schema.some((column) => {
    const role = roles[column.name];
    return role === "body" || (embeddedColumns[column.name] && role !== "title" && role !== "excluded");
  });
  const embeddedFieldCount = schema.filter((column) => roles[column.name] === "title" || embeddedColumns[column.name]).length;
  return <div className="semantic-real-tab-content"><SectionTitle eyebrow="RAG SEARCH" title="RAG 역할 분석과 실제 근거 검색" description="선택한 Semantic Model의 실제 schema·분석 기준으로 문서를 만들고, 색인된 원문 근거를 직접 검색합니다." action={<Button variant="outline" type="button" disabled={!selectedDatasetId || busy !== null} onClick={onRefresh}><RefreshCw /> profile 새로고침</Button>} /><div className="semantic-real-rag-dataset-switcher">{model.datasets.map((dataset) => <button type="button" key={dataset.datasetId} className={dataset.datasetId === selectedDatasetId ? "active" : ""} onClick={() => onDatasetChange(dataset.datasetId)}><Database size={16} /><span><strong>{dataset.name ?? dataset.datasetId}</strong><small>{statusLabel(profile?.datasetId === dataset.datasetId ? profile.reviewState : "not_configured")}</small></span></button>)}</div>{!profile ? <Card size="none" className="semantic-real-rag-empty"><Sparkles /><strong>아직 RAG 분석 결과가 없습니다.</strong><p>Catalog schema와 선택된 분석 기준을 AI에 전달해 컬럼 역할을 추천합니다.</p><Button type="button" disabled={busy !== null} onClick={onClassify}><Sparkles /> AI 컬럼 분석 시작</Button></Card> : <><div className="semantic-real-rag-summary"><span><strong>{profile.schema.length}</strong>개 schema 컬럼</span><span><strong>{embeddedFieldCount}</strong>개 임베딩 포함</span><span><strong>{profile.recommendations.length}</strong>개 추천</span><span><strong>{statusLabel(profile.reviewState)}</strong></span><span><strong>{hasServingIndex ? statusLabel(profile.servingStatus ?? "serving") : statusLabel(profile.indexStatus)}</strong></span>{profile.activeEmbeddingModel && <span><strong>{[profile.activeEmbeddingProvider, profile.activeEmbeddingModel, profile.activeEmbeddingDimensions ? `${profile.activeEmbeddingDimensions}차원` : null].filter(Boolean).join(" · ")}</strong></span>}<Button type="button" disabled={busy !== null} onClick={onClassify}><RefreshCw /> AI 재분석</Button></div><Card size="none" className="semantic-real-rag-role-card"><div className="semantic-real-card-heading"><div><span className="semantic-real-eyebrow">SCHEMA → RAG ROLE</span><h3>전체 schema와 검색 역할</h3><p>제목과 본문은 여러 컬럼을 선택할 수 있으며, 선택된 모든 값이 필드명과 함께 하나의 문서로 합쳐져 청킹·임베딩됩니다.</p></div><div className="semantic-real-role-heading-actions"><Badge variant={profile.classifierConfidence && profile.classifierConfidence >= 0.8 ? "success" : "warning"}>{profile.classifier ? `${profile.classifier} · ${Math.round((profile.classifierConfidence ?? 0) * 100)}%` : "분석 결과"}</Badge><Button variant="outline" type="button" onClick={includeWholeDocument}><FileText /> 제외 필드 빼고 전체 포함</Button></div></div><div className="semantic-real-embedding-guide"><strong>실제 임베딩 입력: {embeddedFieldCount}개 필드</strong><span>문서 제목은 항상 포함됩니다. 필터 메타데이터와 식별자도 아래 체크를 켜면 원래 역할을 유지하면서 본문 임베딩에 함께 들어갑니다.</span></div><div className="semantic-real-role-table"><div className="header"><span>실제 컬럼</span><span>데이터 타입</span><span>AI 추천 이유</span><span>주 역할</span><span>임베딩 포함</span></div>{schema.map((column) => { const role = roles[column.name] ?? "excluded"; const recommendation = profile.recommendations.find((item) => item.columnName === column.name); const alwaysEmbedded = role === "body" || role === "title"; const cannotEmbed = role === "excluded"; return <div key={column.name}><code>{column.name}</code><span>{column.dataType}</span><small>{recommendation?.reason ?? "Semantic 바인딩 또는 사용자 선택"}</small><select value={role} onChange={(event) => selectRole(column.name, event.target.value)}><option value="body">검색 본문</option><option value="title">문서 제목</option><option value="metadata">필터 메타데이터</option><option value="identifier">문서 식별자</option><option value="excluded">제외</option></select><label className="semantic-real-embedding-toggle"><input type="checkbox" checked={alwaysEmbedded || Boolean(embeddedColumns[column.name])} disabled={alwaysEmbedded || cannotEmbed} onChange={(event) => setEmbeddedColumns((current) => ({ ...current, [column.name]: event.target.checked }))} /><span>{cannotEmbed ? "제외됨" : alwaysEmbedded ? "자동 포함" : "본문에도 포함"}</span></label></div>; })}</div><div className="semantic-real-rag-actions"><Button variant="outline" type="button" disabled={busy !== null || !hasEmbeddingBody} onClick={approveWithRoles}><ShieldCheck /> 역할 승인 및 문서 미리보기</Button><Button type="button" disabled={busy !== null || profile.reviewState !== "approved"} onClick={onIndex}>{hasServingIndex ? <RefreshCw /> : <Check />} {hasServingIndex ? "다시 색인" : "VectorDB 색인"}</Button></div></Card><RagJobHistory datasetId={selectedDatasetId} refreshToken={jobsRefreshToken} /><RagSearchPanel datasetId={selectedDatasetId} profile={profile} /><DocumentPreview profile={profile} documents={previewDocuments} /></>}</div>;
}

function RagSearchPanel({ datasetId, profile }: { datasetId: string; profile: RagProfile }) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<RagSearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchReady = Boolean(profile.targetAlias && profile.activeIndex)
    && (profile.servingStatus === "serving" || profile.servingStatus === "stale" || (!profile.servingStatus && profile.indexStatus === "ready"));

  useEffect(() => {
    setQuery("");
    setResult(null);
    setSearchError(null);
  }, [datasetId]);

  const submit = async () => {
    const normalizedQuery = query.trim();
    if (!searchReady || !normalizedQuery) return;
    setSearching(true);
    setSearchError(null);
    try {
      setResult(await searchRagDataset(datasetId, normalizedQuery));
    } catch (searchFailure) {
      setResult(null);
      setSearchError(searchFailure instanceof Error ? searchFailure.message : "RAG 근거 검색에 실패했습니다.");
    } finally {
      setSearching(false);
    }
  };

  return (
    <Card size="none" className="semantic-real-rag-search-card">
      <div className="semantic-real-card-heading">
        <div>
          <span className="semantic-real-eyebrow">LIVE HYBRID RETRIEVAL</span>
          <h3>실제 VectorDB 근거 검색</h3>
          <p>AI Gateway 임베딩과 OpenSearch 하이브리드 검색 결과를 원문 근거 그대로 표시합니다.</p>
        </div>
        <Badge variant={searchReady ? "success" : "warning"}>{searchReady ? "검색 가능" : "색인 필요"}</Badge>
      </div>
      <form className="semantic-real-rag-search-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <Input
          aria-label="RAG 검색 질문"
          disabled={!searchReady || searching}
          placeholder={searchReady ? "예: 배송이 늦고 배터리가 오래가는 무선 이어폰 리뷰" : "역할 승인과 VectorDB 색인을 먼저 완료하세요."}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button type="submit" disabled={!searchReady || searching || !query.trim()}>
          {searching ? <Loader2 className="semantic-spin" /> : <Search />} 실제 근거 검색
        </Button>
      </form>
      {!searchReady && <p className="semantic-real-rag-search-guidance">현재 색인의 serving 상태가 아닙니다. 역할을 승인하고 VectorDB 색인을 완료하면 검색할 수 있습니다.</p>}
      {profile.servingStatus === "stale" && <div className="semantic-real-rag-search-error" role="status"><AlertTriangle />현재 근거는 이전 Dataset 버전의 색인입니다. 검색은 가능하지만 다시 색인해야 최신 데이터가 반영됩니다.</div>}
      {searchError && <div className="semantic-real-rag-search-error" role="alert"><AlertTriangle />{searchError}</div>}
      {result && <RagSearchResults result={result} />}
    </Card>
  );
}

function RagSearchResults({ result }: { result: RagSearchResponse }) {
  const resultCount = typeof result.retrieval.resultCount === "number" ? result.retrieval.resultCount : result.sources.length;
  const aliases = Array.isArray(result.retrieval.aliases) ? result.retrieval.aliases.join(", ") : "";
  const retrievalStatus = String(result.retrieval.status ?? "complete");
  const filterLabels = ragAppliedFilterLabels(result.retrieval.filters);
  const fallbackEvidenceCount = typeof result.retrieval.fallbackEvidenceCount === "number"
    ? result.retrieval.fallbackEvidenceCount
    : result.sources.filter((source) => source.fallbackApplied).length;
  const queryEmbeddings = Object.entries(result.retrieval.queryEmbeddings ?? {});
  return (
    <div className="semantic-real-rag-search-results" aria-live="polite">
      <div className="semantic-real-rag-retrieval-summary">
        <strong>{resultCount}개 실제 근거</strong>
        <span>{result.retrieval.mode ?? "hybrid"} · {statusLabel(retrievalStatus)}</span>
        {aliases && <code>{aliases}</code>}
        {result.retrieval.servingIndex && <code>{String(result.retrieval.servingIndex)}</code>}
        {(result.retrieval.queryPlannerProvider || result.retrieval.queryPlannerModel) && <code>검색 계획 {[result.retrieval.queryPlannerProvider, result.retrieval.queryPlannerModel].filter(Boolean).join(" · ")}</code>}
        {queryEmbeddings.map(([datasetId, embedding]) => <code key={`query-embedding-${datasetId}`}>쿼리 임베딩 {datasetId} · {[embedding.provider, embedding.model, embedding.dimensions ? `${embedding.dimensions}차원` : null].filter(Boolean).join(" · ")}</code>)}
        {(result.retrieval.relevanceProvider || result.retrieval.relevanceModel) && <code>관련성 검증 {[result.retrieval.relevanceProvider, result.retrieval.relevanceModel].filter(Boolean).join(" · ")}</code>}
        {filterLabels.map((label) => <code key={label}>{label}</code>)}
        {fallbackEvidenceCount > 0 && <Badge variant="warning">임베딩 전용 청킹 {fallbackEvidenceCount}건</Badge>}
      </div>
      {result.sources.length === 0 ? <div className="semantic-real-rag-search-empty">{ragRetrievalEmptyMessage(retrievalStatus)}</div> : <div className="semantic-real-rag-search-sources">
        {result.sources.map((source, index) => (
          <article key={`${source.documentId}-${index}`}>
            <div className="semantic-real-rag-source-head">
              <div><span>근거 {index + 1}</span><h4>{ragEvidenceTitle(source.title, source.body)}</h4></div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                {source.fallbackApplied && <Badge variant="warning">LLM 경계 조정 폴백</Badge>}
                {typeof source.score === "number" && <Badge variant="secondary">관련성 {Math.round(source.score * 100)}%</Badge>}
              </div>
            </div>
            <p>{source.body || "본문이 비어 있습니다."}</p>
            {source.relevanceReason && <small>{source.relevanceReason}</small>}
            {source.fallbackApplied && <small>청킹 방식: {(source.chunkingStrategies ?? [source.chunkingStrategy]).filter(Boolean).join(", ") || "semantic_embedding_fallback"} · 사유: {(source.fallbackReasons ?? [source.fallbackReason]).filter(Boolean).join(", ") || "경계 조정 응답 검증 실패"}</small>}
            {Object.keys(source.metadata ?? {}).length > 0 && <dl>{Object.entries(source.metadata).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl>}
            <footer><code>{source.documentId}</code>{source.sourceRowId && <span>원본 행 {source.sourceRowId}</span>}{(source.embeddingProvider || source.embeddingModel) && <span>임베딩 {[source.embeddingProvider, source.embeddingModel, source.embeddingDimensions ? `${source.embeddingDimensions}차원` : null].filter(Boolean).join(" · ")}</span>}{source.chunkingVersion && <span>청킹 {source.chunkingVersion}</span>}{source.sourceFields?.length > 0 && <span>필드 {source.sourceFields.map(ragSourceFieldLabel).join(", ")}</span>}</footer>
          </article>
        ))}
      </div>}
    </div>
  );
}

function ragRetrievalEmptyMessage(status: string) {
  if (status === "query_planning_unavailable") return "질문의 검색 조건을 안전하게 해석하지 못해 근거 검색을 중단했습니다.";
  if (status === "relevance_unavailable") return "검색 후보의 관련성을 검증하지 못해 근거를 표시하지 않았습니다.";
  if (status === "no_relevant_evidence") return "질문을 직접 뒷받침하는 근거가 없어 결과를 표시하지 않았습니다.";
  if (status === "degraded_no_matches") return "쿼리 임베딩을 사용할 수 없어 키워드 검색만 수행했지만 일치하는 근거가 없었습니다.";
  return "검색어와 일치하는 실제 근거가 없습니다.";
}

function ragAppliedFilterLabels(value: unknown) {
  if (!value || typeof value !== "object") return [];
  const labels: string[] = [];
  Object.entries(value as Record<string, unknown>).forEach(([datasetId, datasetFilters]) => {
    if (!datasetFilters || typeof datasetFilters !== "object") return;
    Object.entries(datasetFilters as Record<string, unknown>).forEach(([field, predicate]) => {
      if (!predicate || typeof predicate !== "object") return;
      const item = predicate as Record<string, unknown>;
      if (item.operator && item.value !== undefined) labels.push(`${datasetId} · ${field} ${String(item.operator)} ${String(item.value)}`);
    });
  });
  return labels;
}

function ragEvidenceTitle(value: string | null | undefined, _body?: string | null) {
  const title = String(value ?? "")
    .replace(/\[\/?TITLE\]/gi, "")
    .trim();
  if (title) return title;
  return "제목 없는 문서";
}

function ragSourceFieldLabel(field: string | { logicalField?: string; physicalField?: string; role?: string }) {
  if (typeof field === "string") return field;
  const logical = String(field.logicalField ?? field.physicalField ?? "unknown");
  const physical = field.physicalField && field.physicalField !== logical ? ` (${field.physicalField})` : "";
  const role = field.role ? ` · ${roleLabel(field.role)}` : "";
  return `${logical}${physical}${role}`;
}

function DocumentPreview({ profile, documents }: { profile: RagProfile; documents: RagDocument[] }) {
  const servingReady = profile.servingStatus === "serving" || profile.servingStatus === "stale";
  return <Card size="none" className="semantic-real-document-card"><div className="semantic-real-card-heading"><div><span className="semantic-real-eyebrow">DOCUMENT PREVIEW</span><h3>VectorDB에 들어간 실제 문서</h3><p>임베딩 숫자 배열 대신, 어떤 필드가 어떤 문자열로 합쳐져 임베딩되는지 직접 확인합니다.</p></div><Badge variant={servingReady ? "success" : "muted"}>{statusLabel(servingReady ? profile.servingStatus ?? "serving" : profile.embeddingStatus)}</Badge></div>{documents.length === 0 ? <div className="semantic-real-document-empty"><FileText /><span>승인 후 실제 적재 문서가 표시됩니다.</span></div> : <div className="semantic-real-documents">{documents.map((document) => <article key={document.documentId}><div className="semantic-real-document-head"><code>{document.sourceRowId}</code><Badge size="sm">{statusLabel(document.embeddingStatus)}</Badge></div>{document.title && <strong>{document.title}</strong>}<p>{document.body}</p><div>{Object.entries(document.metadataDisplay).map(([key, value]) => <span key={key}><code>{key}</code>{String(value)}</span>)}</div>{document.embeddingText && <details className="semantic-real-embedding-preview"><summary>실제 임베딩 입력 보기</summary><pre>{document.embeddingText}</pre></details>}<small>{document.sourceDataset} · {document.sourceColumns.join(", ")} → {document.targetIndex}</small></article>)}</div>}</Card>;
}

function AccessTab({ model }: { model: SemanticModel }) {
  return <div className="semantic-real-tab-content"><SectionTitle eyebrow="MODEL ACCESS" title="접근 권한" description="실제 요청마다 서버가 업무 모델과 Dataset 권한을 다시 확인합니다." /><Card size="none" className="semantic-real-access-card">{model.permissionGrants.length ? model.permissionGrants.map((grant) => <div key={`${grant.principalType}-${grant.principalId}`}><ShieldCheck /><strong>{grant.principalId}</strong><span>{grant.principalType}</span><div>{grant.actions.map((action) => <Badge key={action} size="sm">{action}</Badge>)}</div></div>) : <p>등록된 권한 규칙이 없습니다.</p>}</Card></div>;
}

function SectionTitle({ eyebrow, title, titleId, description, action }: { eyebrow: string; title: string; titleId?: string; description: string; action?: ReactNode }) {
  return <div className="semantic-real-section-title"><div><span className="semantic-real-eyebrow">{eyebrow}</span><h2 id={titleId}>{title}</h2><p>{description}</p></div>{action}</div>;
}

function CreateModelPanel({ datasets, busy, onCancel, onCreate }: { datasets: CatalogDataset[]; busy: boolean; onCancel: () => void; onCreate: (name: string, description: string, datasetIds: string[]) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  return <Card size="none" className="semantic-real-create"><div><span className="semantic-real-eyebrow">NEW SEMANTIC MODEL</span><h2>실제 DB에 업무 모델 생성</h2></div><Input value={name} onChange={(event) => setName(event.target.value)} placeholder="업무 모델 이름" /><Textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="이 모델이 어떤 업무 기준을 묶는지 설명" rows={3} /><div className="semantic-real-create-datasets">{datasets.map((dataset) => <label key={dataset.id}><input type="checkbox" checked={selectedIds.includes(dataset.id)} onChange={(event) => setSelectedIds((current) => event.target.checked ? [...current, dataset.id] : current.filter((id) => id !== dataset.id))} /><span>{dataset.name}<small>{dataset.schema.length}개 컬럼 · {dataset.rows}</small></span></label>)}</div><div><Button variant="outline" type="button" onClick={onCancel}>취소</Button><Button disabled={busy || !name.trim() || selectedIds.length === 0} type="button" onClick={() => onCreate(name.trim(), description, selectedIds)}>{busy ? <Loader2 className="semantic-spin" /> : <Plus />} 생성</Button></div></Card>;
}

function EmptyModelState({ onCreate }: { onCreate: () => void }) {
  return <Card size="none" className="semantic-real-empty-model"><Database /><h2>실제 업무 모델이 없습니다.</h2><p>Catalog Dataset을 선택해 첫 업무 모델을 실제 DB에 생성하세요.</p><Button type="button" onClick={onCreate}><Plus /> 업무 모델 생성</Button></Card>;
}
