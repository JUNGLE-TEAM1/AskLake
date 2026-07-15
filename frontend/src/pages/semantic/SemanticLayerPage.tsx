import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, Check, Database, FileText, Loader2, Plus, RefreshCw, Save, ShieldCheck, Sparkles, X } from "lucide-react";
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
  updateSemanticModel,
  validateSemanticModel,
  type RagDocument,
  type RagProfile,
  type SemanticDataset,
  type SemanticDimension,
  type SemanticMetric,
  type SemanticModel,
  type SemanticSchemaColumn,
} from "../../services/semanticApi";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { RagServingStatus } from "../../components/semantic/RagServingStatus";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import "../../styles/semantic-layer-real.css";

type Tab = "datasets" | "metrics" | "dimensions" | "rag" | "access";
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
    failed: "실패",
  };
  return labels[status] ?? status;
}

function roleLabel(role: string) {
  return ({ body: "본문", title: "문서 제목", metadata: "필터 메타데이터", identifier: "문서 식별자", excluded: "제외" } as Record<string, string>)[role] ?? role;
}

function schemaColumnLabel(column: SemanticSchemaColumn) {
  return `${column.name} · ${column.dataType}`;
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
      await indexRagDataset(ragDatasetId, ragProfile?.indexStatus === "ready" ? "reindex" : "index");
      await refreshProfile(ragDatasetId);
      setNotice({ tone: "info", message: "RAG 색인 작업을 요청했습니다. 작업 상태는 Dataset profile에서 확인합니다." });
    });
  };

  if (loading) return <div className="semantic-real-loading" role="status"><Loader2 className="semantic-spin" /> 실제 Semantic Model과 Catalog schema를 불러오는 중입니다.</div>;
  if (error) return <div className="semantic-real-error" role="alert"><AlertTriangle /><div><strong>실제 백엔드 연결이 필요합니다.</strong><p>{error}</p><Button type="button" onClick={() => void load()}><RefreshCw /> 다시 시도</Button></div></div>;

  return (
    <section className="semantic-real-page" aria-label="실제 업무 모델 관리">
      {notice && <div className={`semantic-real-notice ${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>{notice.message}<button type="button" aria-label="알림 닫기" onClick={() => setNotice(null)}><X size={15} /></button></div>}
      <div className="semantic-real-toolbar">
        <div><span className="semantic-real-eyebrow">CATALOG / 업무 모델</span><h1>업무 모델</h1><p>Catalog의 실제 schema를 선택해 지표·분석 기준과 RAG 문서를 연결합니다.</p></div>
        <div className="semantic-real-toolbar-actions"><Button variant="outline" type="button" onClick={() => void load()}><RefreshCw /> 새로고침</Button><Button type="button" onClick={() => setCreateOpen(true)}><Plus /> 업무 모델 추가</Button></div>
      </div>
      {createOpen && <CreateModelPanel datasets={catalogDatasets} busy={busy === "create"} onCancel={() => setCreateOpen(false)} onCreate={(name, description, datasetIds) => void run("create", async () => { const created = await createSemanticModel({ name, description, datasets: datasetIds.map((datasetId) => ({ datasetId, role: "source" as const })) }); setModels((current) => [created, ...current]); setSelectedModelId(created.id); setCreateOpen(false); setNotice({ tone: "success", message: "실제 데이터베이스에 업무 모델을 생성했습니다." }); })} />}
      {!selected ? <EmptyModelState onCreate={() => setCreateOpen(true)} /> : <>
        <div className="semantic-real-model-layout">
          <aside className="semantic-real-model-list" aria-label="업무 모델 목록">
            <div className="semantic-real-list-heading"><strong>업무 모델</strong><span>{models.length}개</span></div>
            {models.map((model) => <button type="button" key={model.id} className={model.id === selected.id ? "active" : ""} onClick={() => setSelectedModelId(model.id)}><span className="semantic-real-model-dot" /><span><strong>{model.name}</strong><small>{statusLabel(model.status)} · v{model.version}</small></span></button>)}
          </aside>
          <main className="semantic-real-editor">
            <ModelHeader model={selected} busy={busy === "model"} onSave={saveModelInfo} onValidate={() => void run("validate", async () => { const result = await validateSemanticModel(selected.id); setNotice({ tone: result.valid ? "success" : "error", message: result.valid ? "게시 검증을 통과했습니다." : result.errors.join(" / ") }); })} onPublish={() => void run("publish", async () => { const result = await publishSemanticModel(selected.id); setModels((current) => current.map((model) => model.id === result.model.id ? result.model : model)); setNotice({ tone: "success", message: `업무 모델 v${result.publishedVersion}를 게시했습니다.` }); })} />
            <nav className="semantic-real-tabs" aria-label="업무 모델 편집 탭">{([ ["datasets", "데이터 연결"], ["metrics", "지표"], ["dimensions", "분석 기준"], ["rag", "RAG 검색"], ["access", "접근 권한"]] as Array<[Tab, string]>).map(([id, label]) => <button type="button" key={id} className={activeTab === id ? "active" : ""} onClick={() => setActiveTab(id)}>{label}{id === "datasets" && <em>{selected.datasets.length}</em>}{id === "metrics" && <em>{selected.metrics.length}</em>}{id === "dimensions" && <em>{selected.dimensions.length}</em>}{id === "rag" && <em>{Object.values(profiles).filter((profile) => profile.indexStatus === "ready").length}</em>}</button>)}</nav>
            {activeTab === "datasets" && <DatasetsTab model={selected} catalogDatasets={catalogDatasets} onSave={saveDatasets} />}
            {activeTab === "metrics" && <MetricsTab model={selected} catalogDatasets={catalogDatasets} onSave={saveMetrics} />}
            {activeTab === "dimensions" && <DimensionsTab model={selected} catalogDatasets={catalogDatasets} onSave={saveDimensions} />}
            {activeTab === "rag" && <><RagServingStatus profile={ragProfile} /><RagTab model={selected} selectedDatasetId={ragDatasetId} profile={ragProfile} previewDocuments={previews[ragDatasetId] ?? []} onDatasetChange={setSelectedRagDatasetId} onRefresh={() => void run("profile", async () => refreshProfile(ragDatasetId))} onClassify={classify} onApprove={approve} onIndex={index} busy={busy} /></>}
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
  return <div className="semantic-real-model-header"><div><span className="semantic-real-eyebrow">{statusLabel(model.status)} · v{model.version} · 소유자 {model.owner}</span><Input value={name} onChange={(event) => setName(event.target.value)} aria-label="업무 모델 이름" /><Textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={2} aria-label="업무 모델 설명" /></div><div className="semantic-real-header-actions"><span className="semantic-real-save-state">실제 DB 저장</span><Button variant="outline" disabled={busy} type="button" onClick={() => void onSave(name.trim(), description)}><Save /> 저장</Button><Button variant="outline" type="button" onClick={onValidate}><ShieldCheck /> 검증</Button><Button type="button" onClick={onPublish}><Check /> 게시</Button></div></div>;
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

function MetricsTab({ model, catalogDatasets, onSave }: { model: SemanticModel; catalogDatasets: CatalogDataset[]; onSave: (metrics: SemanticMetric[]) => Promise<void> }) {
  const [metrics, setMetrics] = useState(model.metrics);
  useEffect(() => setMetrics(model.metrics), [model.id, model.metrics]);
  const update = (id: string, patch: Partial<SemanticMetric>) => setMetrics((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  return <div className="semantic-real-tab-content"><SectionTitle eyebrow="METRICS" title="지표의 실제 원본 컬럼" description="계산식과 함께 어떤 Catalog schema 컬럼을 사용하는지 저장합니다." action={<Button type="button" onClick={() => void onSave(metrics)}><Save /> 지표 저장</Button>} /><div className="semantic-real-definition-list">{metrics.map((metric) => <Card key={metric.id} className="semantic-real-definition-card" size="none"><div className="semantic-real-definition-main"><Input value={metric.label} onChange={(event) => update(metric.id, { label: event.target.value })} aria-label={`${metric.name} 표시명`} /><code>{metric.name}</code><Input value={metric.expression} onChange={(event) => update(metric.id, { expression: event.target.value })} aria-label={`${metric.name} 계산식`} /></div><PhysicalColumnPicker model={model} catalogDatasets={catalogDatasets} datasetId={metric.datasetId ?? ""} selectedColumns={metric.sourceColumns} onDatasetChange={(datasetId) => update(metric.id, { datasetId, sourceColumns: [] })} onColumnsChange={(sourceColumns) => update(metric.id, { sourceColumns })} /></Card>)}</div></div>;
}

function DimensionsTab({ model, catalogDatasets, onSave }: { model: SemanticModel; catalogDatasets: CatalogDataset[]; onSave: (dimensions: SemanticDimension[]) => Promise<void> }) {
  const [dimensions, setDimensions] = useState(model.dimensions);
  useEffect(() => setDimensions(model.dimensions), [model.id, model.dimensions]);
  const update = (id: string, patch: Partial<SemanticDimension>) => setDimensions((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  return <div className="semantic-real-tab-content"><SectionTitle eyebrow="DIMENSIONS" title="분석 기준의 실제 schema 컬럼" description="분석 기준을 만들 때 실제 Catalog Dataset과 컬럼을 선택합니다." action={<Button type="button" onClick={() => void onSave(dimensions)}><Save /> 분석 기준 저장</Button>} /><div className="semantic-real-definition-list">{dimensions.map((dimension) => <Card key={dimension.id} className="semantic-real-definition-card" size="none"><div className="semantic-real-definition-main"><Input value={dimension.label} onChange={(event) => update(dimension.id, { label: event.target.value })} aria-label={`${dimension.name} 표시명`} /><code>{dimension.name}</code><Input value={dimension.description} onChange={(event) => update(dimension.id, { description: event.target.value })} aria-label={`${dimension.name} 설명`} /></div><PhysicalColumnPicker model={model} catalogDatasets={catalogDatasets} datasetId={dimension.datasetId ?? ""} selectedColumns={dimension.columnName ? [dimension.columnName] : []} single onDatasetChange={(datasetId) => update(dimension.id, { datasetId, columnName: "", dataType: "" })} onColumnsChange={(columns) => { const column = schemaFor(modelDataset(model, dimension.datasetId), catalogDatasets).find((item) => item.name === columns[0]); update(dimension.id, { columnName: columns[0] ?? "", dataType: column?.dataType ?? "" }); }} /></Card>)}</div></div>;
}

function PhysicalColumnPicker({ model, catalogDatasets, datasetId, selectedColumns, single = false, onDatasetChange, onColumnsChange }: { model: SemanticModel; catalogDatasets: CatalogDataset[]; datasetId: string; selectedColumns: string[]; single?: boolean; onDatasetChange: (datasetId: string) => void; onColumnsChange: (columns: string[]) => void }) {
  const dataset = modelDataset(model, datasetId);
  const schema = schemaFor(dataset, catalogDatasets);
  return <div className="semantic-real-binding"><label>원본 Dataset<select value={datasetId} onChange={(event) => onDatasetChange(event.target.value)}><option value="">선택하세요</option>{model.datasets.map((item) => <option key={item.datasetId} value={item.datasetId}>{item.name ?? item.datasetId}</option>)}</select></label><div><span>실제 schema 컬럼</span><div className="semantic-real-column-options">{schema.map((column) => <label key={column.name}><input type={single ? "radio" : "checkbox"} name={single ? `schema-${datasetId}` : undefined} checked={selectedColumns.includes(column.name)} onChange={(event) => onColumnsChange(single ? [column.name] : event.target.checked ? [...selectedColumns, column.name] : selectedColumns.filter((item) => item !== column.name))} /><code>{schemaColumnLabel(column)}</code></label>)}</div></div></div>;
}

function RagTab({ model, selectedDatasetId, profile, previewDocuments, onDatasetChange, onRefresh, onClassify, onApprove, onIndex, busy }: { model: SemanticModel; selectedDatasetId: string; profile?: RagProfile; previewDocuments: RagDocument[]; onDatasetChange: (id: string) => void; onRefresh: () => void; onClassify: () => void; onApprove: (roles: RagRolePayload) => void; onIndex: () => void; busy: string | null }) {
  const [roles, setRoles] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!profile) return;
    const next: Record<string, string> = {};
    profile.bodyColumns.forEach((column) => { next[column] = "body"; });
    profile.titleColumns.forEach((column) => { next[column] = "title"; });
    profile.metadataColumns.forEach((column) => { next[column] = "metadata"; });
    profile.identifierColumns.forEach((column) => { next[column] = "identifier"; });
    profile.excludedColumns.forEach((column) => { next[column] = "excluded"; });
    profile.recommendations.forEach((item) => { if (!next[item.columnName]) next[item.columnName] = item.role; });
    setRoles(next);
  }, [profile]);
  const schema = profile?.schema ?? modelDataset(model, selectedDatasetId)?.schema ?? [];
  const selectRole = (column: string, role: string) => setRoles((current) => ({ ...current, [column]: role }));
  const approveWithRoles = () => {
    if (!profile) return;
    onApprove({
      bodyColumns: schema.filter((column) => roles[column.name] === "body").map((column) => column.name),
      titleColumns: schema.filter((column) => roles[column.name] === "title").map((column) => column.name),
      metadataColumns: schema.filter((column) => roles[column.name] === "metadata").map((column) => column.name),
      identifierColumns: schema.filter((column) => roles[column.name] === "identifier").map((column) => column.name),
      excludedColumns: schema.filter((column) => roles[column.name] === "excluded").map((column) => column.name),
    });
  };
  return <div className="semantic-real-tab-content"><SectionTitle eyebrow="RAG SEARCH" title="RAG 역할 분석과 실제 적재 문서" description="선택한 Semantic Model의 실제 schema·지표·분석 기준을 함께 사용해 컬럼 역할을 분석합니다." action={<Button variant="outline" type="button" disabled={!selectedDatasetId || busy !== null} onClick={onRefresh}><RefreshCw /> profile 새로고침</Button>} /><div className="semantic-real-rag-dataset-switcher">{model.datasets.map((dataset) => <button type="button" key={dataset.datasetId} className={dataset.datasetId === selectedDatasetId ? "active" : ""} onClick={() => onDatasetChange(dataset.datasetId)}><Database size={16} /><span><strong>{dataset.name ?? dataset.datasetId}</strong><small>{statusLabel(profile?.datasetId === dataset.datasetId ? profile.reviewState : "not_configured")}</small></span></button>)}</div>{!profile ? <Card size="none" className="semantic-real-rag-empty"><Sparkles /><strong>아직 RAG 분석 결과가 없습니다.</strong><p>Catalog schema와 선택된 지표·분석 기준을 AI에 전달해 컬럼 역할을 추천합니다.</p><Button type="button" disabled={busy !== null} onClick={onClassify}><Sparkles /> AI 컬럼 분석 시작</Button></Card> : <><div className="semantic-real-rag-summary"><span><strong>{profile.schema.length}</strong>개 schema 컬럼</span><span><strong>{profile.recommendations.length}</strong>개 추천</span><span><strong>{statusLabel(profile.reviewState)}</strong></span><span><strong>{statusLabel(profile.indexStatus)}</strong></span><Button type="button" disabled={busy !== null} onClick={onClassify}><RefreshCw /> AI 재분석</Button></div><Card size="none" className="semantic-real-rag-role-card"><div className="semantic-real-card-heading"><div><span className="semantic-real-eyebrow">SCHEMA → RAG ROLE</span><h3>전체 schema와 검색 역할</h3><p>역할을 선택하면 아래 문서 미리보기에 실제 반영됩니다.</p></div><Badge variant={profile.classifierConfidence && profile.classifierConfidence >= 0.8 ? "success" : "warning"}>{profile.classifier ? `${profile.classifier} · ${Math.round((profile.classifierConfidence ?? 0) * 100)}%` : "분석 결과"}</Badge></div><div className="semantic-real-role-table"><div className="header"><span>실제 컬럼</span><span>데이터 타입</span><span>AI 추천 이유</span><span>RAG 역할</span></div>{schema.map((column) => { const recommendation = profile.recommendations.find((item) => item.columnName === column.name); return <div key={column.name}><code>{column.name}</code><span>{column.dataType}</span><small>{recommendation?.reason ?? "Semantic 바인딩 또는 사용자 선택"}</small><select value={roles[column.name] ?? "excluded"} onChange={(event) => selectRole(column.name, event.target.value)}><option value="body">본문</option><option value="title">문서 제목</option><option value="metadata">필터 메타데이터</option><option value="identifier">문서 식별자</option><option value="excluded">제외</option></select></div>; })}</div><div className="semantic-real-rag-actions"><Button variant="outline" type="button" disabled={busy !== null || !profile.bodyColumns.length && !Object.values(roles).includes("body")} onClick={approveWithRoles}><ShieldCheck /> 역할 승인 및 문서 미리보기</Button><Button type="button" disabled={busy !== null || profile.reviewState !== "approved"} onClick={onIndex}>{profile.indexStatus === "ready" ? <RefreshCw /> : <Check />} {profile.indexStatus === "ready" ? "다시 색인" : "VectorDB 색인"}</Button></div></Card><DocumentPreview profile={profile} documents={previewDocuments} /></>}</div>;
}

function DocumentPreview({ profile, documents }: { profile: RagProfile; documents: RagDocument[] }) {
  return <Card size="none" className="semantic-real-document-card"><div className="semantic-real-card-heading"><div><span className="semantic-real-eyebrow">DOCUMENT PREVIEW</span><h3>VectorDB에 들어갈 실제 문서</h3><p>임베딩 숫자 배열은 숨기고, 검색 본문·메타데이터·원본 schema만 표시합니다.</p></div><Badge variant={profile.embeddingStatus === "ready" ? "success" : "muted"}>{statusLabel(profile.embeddingStatus)}</Badge></div>{documents.length === 0 ? <div className="semantic-real-document-empty"><FileText /><span>승인 후 실제 적재 문서가 표시됩니다.</span></div> : <div className="semantic-real-documents">{documents.map((document) => <article key={document.documentId}><div className="semantic-real-document-head"><code>{document.sourceRowId}</code><Badge size="sm">{statusLabel(document.embeddingStatus)}</Badge></div>{document.title && <strong>{document.title}</strong>}<p>{document.body}</p><div>{Object.entries(document.metadataDisplay).map(([key, value]) => <span key={key}><code>{key}</code>{String(value)}</span>)}</div><small>{document.sourceDataset} · {document.sourceColumns.join(", ")} → {document.targetIndex}</small></article>)}</div>}</Card>;
}

function AccessTab({ model }: { model: SemanticModel }) {
  return <div className="semantic-real-tab-content"><SectionTitle eyebrow="MODEL ACCESS" title="접근 권한" description="실제 요청마다 서버가 업무 모델과 Dataset 권한을 다시 확인합니다." /><Card size="none" className="semantic-real-access-card">{model.permissionGrants.length ? model.permissionGrants.map((grant) => <div key={`${grant.principalType}-${grant.principalId}`}><ShieldCheck /><strong>{grant.principalId}</strong><span>{grant.principalType}</span><div>{grant.actions.map((action) => <Badge key={action} size="sm">{action}</Badge>)}</div></div>) : <p>등록된 권한 규칙이 없습니다.</p>}</Card></div>;
}

function SectionTitle({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="semantic-real-section-title"><div><span className="semantic-real-eyebrow">{eyebrow}</span><h2>{title}</h2><p>{description}</p></div>{action}</div>;
}

function CreateModelPanel({ datasets, busy, onCancel, onCreate }: { datasets: CatalogDataset[]; busy: boolean; onCancel: () => void; onCreate: (name: string, description: string, datasetIds: string[]) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  return <Card size="none" className="semantic-real-create"><div><span className="semantic-real-eyebrow">NEW SEMANTIC MODEL</span><h2>실제 DB에 업무 모델 생성</h2></div><Input value={name} onChange={(event) => setName(event.target.value)} placeholder="업무 모델 이름" /><Textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="이 모델이 어떤 업무 기준을 묶는지 설명" rows={3} /><div className="semantic-real-create-datasets">{datasets.map((dataset) => <label key={dataset.id}><input type="checkbox" checked={selectedIds.includes(dataset.id)} onChange={(event) => setSelectedIds((current) => event.target.checked ? [...current, dataset.id] : current.filter((id) => id !== dataset.id))} /><span>{dataset.name}<small>{dataset.schema.length}개 컬럼 · {dataset.rows}</small></span></label>)}</div><div><Button variant="outline" type="button" onClick={onCancel}>취소</Button><Button disabled={busy || !name.trim() || selectedIds.length === 0} type="button" onClick={() => onCreate(name.trim(), description, selectedIds)}>{busy ? <Loader2 className="semantic-spin" /> : <Plus />} 생성</Button></div></Card>;
}

function EmptyModelState({ onCreate }: { onCreate: () => void }) {
  return <Card size="none" className="semantic-real-empty-model"><Database /><h2>실제 업무 모델이 없습니다.</h2><p>Mock 데이터는 사용하지 않습니다. Catalog Dataset을 선택해 첫 업무 모델을 실제 DB에 생성하세요.</p><Button type="button" onClick={onCreate}><Plus /> 업무 모델 생성</Button></Card>;
}
