import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowRight, Check, ChevronDown, Database, FileText, Loader2, Pencil, Plus, RefreshCw, Save, Search, ShieldCheck, Sparkles, Table2, Trash2, X } from "lucide-react";
import type { CatalogDataset } from "../../types";
import type { AuditResult } from "../../types/audit";
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
import { Checkbox } from "../../components/ui/checkbox";
import { IconButton } from "../../components/ui/icon-button";
import { Stepper } from "../../components/layout/Stepper";
import { RagJobHistory } from "../../components/semantic/RagJobHistory";
import { Input } from "../../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { Textarea } from "../../components/ui/textarea";
import "../../styles/semantic-layer-real.css";

type Tab = "datasets" | "analysis" | "rag" | "access";
type Notice = { tone: "success" | "error" | "info"; message: string };
type RagRolePayload = Pick<RagProfile, "bodyColumns" | "titleColumns" | "metadataColumns" | "identifierColumns" | "excludedColumns">;

type SemanticPageProps = {
  datasets: CatalogDataset[];
  onAction?: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
};

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

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
}

export function SemanticLayerPage({ datasets: providedDatasets, onAction }: SemanticPageProps) {
  const [models, setModels] = useState<SemanticModel[]>([]);
  const catalogDatasets = providedDatasets;
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
  const busyRef = useRef(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const nextModels = await listSemanticModels();
      setModels(nextModels);
      setProfiles({});
      setPreviews({});
      setSelectedModelId((current) => current && nextModels.some((model) => model.id === current) ? current : nextModels[0]?.id ?? "");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Semantic Model을 불러오지 못했습니다.");
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

  const run = async (key: string, action: () => Promise<void>): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(key);
    setNotice(null);
    try {
      await action();
      return true;
    } catch (actionError) {
      setNotice({ tone: "error", message: actionError instanceof Error ? actionError.message : "요청을 처리하지 못했습니다." });
      return false;
    } finally {
      busyRef.current = false;
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
    if (!selected) return false;
    return run("model", async () => {
      const updated = await updateSemanticModel(selected.id, { name, description });
      setModels((current) => current.map((model) => model.id === updated.id ? updated : model));
      setNotice({ tone: "success", message: "업무 모델 정보가 저장되었습니다." });
      onAction?.("semantic.model.updated", `/api/semantic-models/${selected.id}`, selected.id, "success");
    });
  };

  const saveDatasets = async (nextDatasets: SemanticDataset[]) => {
    if (!selected) return false;
    return run("datasets", async () => {
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
      setNotice({ tone: "success", message: "계산할 값과 실제 원본 컬럼이 저장되었습니다." });
    });
  };

  const saveDimensions = async (dimensions: SemanticDimension[]) => {
    if (!selected) return;
    await run("dimensions", async () => {
      const updated = await replaceSemanticDimensions(selected.id, dimensions.map(({ id: _id, ...dimension }) => dimension));
      setModels((current) => current.map((model) => model.id === updated.id ? updated : model));
      setNotice({ tone: "success", message: "나눠볼 기준과 실제 원본 컬럼이 저장되었습니다." });
    });
  };

  const classify = async () => {
    if (!selected || !ragDatasetId) return;
    await run("classify", async () => {
      await classifyRagDataset(ragDatasetId, selected.id);
      await refreshProfile(ragDatasetId);
      setNotice({ tone: "success", message: "선택한 업무 모델의 분석 기준을 포함해 RAG 컬럼 분석을 완료했습니다." });
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

  const publishSelected = async () => {
    if (!selected) return;
    await run("publish", async () => {
      const validation = await validateSemanticModel(selected.id);
      if (!validation.valid) throw new Error(validation.errors.join(" / "));
      const result = await publishSemanticModel(selected.id);
      setModels((current) => current.map((model) => model.id === result.model.id ? result.model : model));
      setNotice({ tone: "success", message: `업무 모델 v${result.publishedVersion}를 게시했습니다.` });
      onAction?.("semantic.model.published", `/api/semantic-models/${selected.id}/publish`, selected.id, "success");
    });
  };

  if (loading) return <div className="semantic-real-loading" role="status"><Loader2 className="semantic-spin" /> 실제 Semantic Model과 Catalog schema를 불러오는 중입니다.</div>;
  if (error) return <div className="semantic-real-error" role="alert"><AlertTriangle /><div><strong>실제 백엔드 연결이 필요합니다.</strong><p>{error}</p><Button type="button" onClick={() => void load()}><RefreshCw /> 다시 시도</Button></div></div>;

  return (
    <section className="semantic-real-page" aria-label="실제 시맨틱 레이어 관리">
      {notice && <div className={`semantic-real-notice ${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>{notice.message}<IconButton label="알림 닫기" size="xs" type="button" onClick={() => setNotice(null)}><X size={15} /></IconButton></div>}
      <div className="semantic-real-toolbar">
        <div><h1>시맨틱 레이어</h1></div>
      </div>
      {createOpen && <CreateModelPanel datasets={catalogDatasets} busy={busy === "create"} onCancel={() => setCreateOpen(false)} onCreate={(name, description, datasetIds) => void run("create", async () => { const created = await createSemanticModel({ name, description, datasets: datasetIds.map((datasetId) => ({ datasetId, role: "source" as const })) }); setModels((current) => [created, ...current]); setSelectedModelId(created.id); setCreateOpen(false); setNotice({ tone: "success", message: "실제 데이터베이스에 업무 모델을 생성했습니다." }); })} />}
      {!selected ? <EmptyModelState onCreate={() => setCreateOpen(true)} /> : <>
        <main className="semantic-real-editor">
            <div className="semantic-real-model-switcher">
              <label><span>업무 모델</span><Select value={selected.id} onValueChange={setSelectedModelId}><SelectTrigger aria-label="업무 모델 선택" className="semantic-real-model-select-trigger" size="lg"><SelectValue /></SelectTrigger><SelectContent>{models.map((model) => <SelectItem key={model.id} value={model.id}>{model.name}</SelectItem>)}</SelectContent></Select></label>
              <div className="semantic-real-toolbar-actions"><Button type="button" onClick={() => setCreateOpen(true)}><Plus /> 새 모델</Button></div>
            </div>
            <ModelHeader model={selected} busy={busy !== null} onSave={saveModelInfo} onPublish={publishSelected} />
            <ModelWorkflowNav activeTab={activeTab} onChange={setActiveTab} />
            {activeTab === "datasets" && <DatasetsTab model={selected} catalogDatasets={catalogDatasets} onSave={saveDatasets} />}
            {activeTab === "analysis" && <AnalysisDefinitionsTab model={selected} catalogDatasets={catalogDatasets} onSaveMetrics={saveMetrics} onSaveDimensions={saveDimensions} />}
            {activeTab === "rag" && <RagTab model={selected} selectedDatasetId={ragDatasetId} profile={ragProfile} previewDocuments={previews[ragDatasetId] ?? []} jobsRefreshToken={ragJobsRefreshToken} onDatasetChange={setSelectedRagDatasetId} onRefresh={() => void run("profile", async () => refreshProfile(ragDatasetId))} onClassify={classify} onApprove={approve} onIndex={index} busy={busy} />}
            {activeTab === "access" && <AccessTab model={selected} />}
        </main>
      </>}
    </section>
  );
}

function ModelHeader({ model, busy, onSave, onPublish }: { model: SemanticModel; busy: boolean; onSave: (name: string, description: string) => Promise<boolean>; onPublish: () => Promise<void> }) {
  const [name, setName] = useState(model.name);
  const [description, setDescription] = useState(model.description);
  const [editing, setEditing] = useState(false);
  useEffect(() => { setName(model.name); setDescription(model.description); setEditing(false); }, [model.id, model.name, model.description]);
  const cancel = () => { setName(model.name); setDescription(model.description); setEditing(false); };
  const save = async () => { if (await onSave(name.trim(), description)) setEditing(false); };
  return <Card size="none" className="semantic-real-model-header">
    <div className="semantic-real-model-summary">
      <div>
        <div className="semantic-real-model-status"><Badge variant={model.status === "published" ? "success" : "muted"}>{statusLabel(model.status)}</Badge><span>버전 {semanticModelDisplayVersion(model)}</span><span>소유자 {model.owner}</span></div>
        <h2>{model.name}</h2>
        <p>{model.description || "이 모델이 어떤 업무 질문에 답하는지 설명을 추가해 주세요."}</p>
      </div>
      <div className="semantic-real-header-actions">
        <Button variant="outline" type="button" disabled={busy} onClick={() => setEditing((current) => !current)}><Pencil /> 정보 수정</Button>
        <Button type="button" disabled={busy || model.status === "published"} onClick={() => void onPublish()}>{model.status === "published" ? <Check /> : <ArrowRight />} {model.status === "published" ? "게시 완료" : "게시하기"}</Button>
      </div>
    </div>
    {editing && <div className="semantic-real-model-edit">
      <label>모델 이름<Input value={name} onChange={(event) => setName(event.target.value)} aria-label="업무 모델 이름" /></label>
      <label>설명<Textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={2} aria-label="업무 모델 설명" /></label>
      <div><Button variant="ghost" type="button" onClick={cancel}>취소</Button><Button disabled={busy || !name.trim()} type="button" onClick={() => void save()}><Save /> 저장</Button></div>
    </div>}
  </Card>;
}

function ModelWorkflowNav({ activeTab, onChange }: { activeTab: Tab; onChange: (tab: Tab) => void }) {
  const steps: Array<{ id: Tab; number: number; title: string }> = [
    { id: "datasets", number: 1, title: "데이터 선택" },
    { id: "analysis", number: 2, title: "분석 기준" },
    { id: "rag", number: 3, title: "AI 검색" },
    { id: "access", number: 4, title: "권한" },
  ];
  const activeIndex = Math.max(0, steps.findIndex((step) => step.id === activeTab));
  return <nav className="semantic-real-workflow" aria-label="업무 모델 설정 순서">
    <Stepper activeIndex={activeIndex} steps={steps.map((step) => step.title)} onStepSelect={(index) => onChange(steps[index].id)} />
  </nav>;
}

function DatasetsTab({ model, catalogDatasets, onSave }: { model: SemanticModel; catalogDatasets: CatalogDataset[]; onSave: (datasets: SemanticDataset[]) => Promise<boolean> }) {
  const [datasets, setDatasets] = useState(model.datasets);
  const [pickerOpen, setPickerOpen] = useState(model.datasets.length === 0);
  useEffect(() => { setDatasets(model.datasets); setPickerOpen(model.datasets.length === 0); }, [model.id, model.datasets]);
  const toggle = (datasetId: string) => setDatasets((current) => current.some((item) => item.datasetId === datasetId) ? current.filter((item) => item.datasetId !== datasetId) : [...current, { id: `draft-${datasetId}`, datasetId, role: "source", joinConfig: {}, schema: [], description: "" }]);
  const savedIds = [...model.datasets.map((item) => item.datasetId)].sort().join("|");
  const draftIds = [...datasets.map((item) => item.datasetId)].sort().join("|");
  const hasChanges = savedIds !== draftIds;
  const cancel = () => { setDatasets(model.datasets); setPickerOpen(false); };
  const save = async () => { if (await onSave(datasets)) setPickerOpen(false); };
  return <div className="semantic-real-tab-content">
    <SectionTitle title="어떤 데이터를 설명할까요?" action={<Button variant="outline" type="button" onClick={() => setPickerOpen(true)}><Plus /> 데이터 변경</Button>} />
    {datasets.length === 0 ? <Card size="none" className="semantic-real-definition-empty"><Database /><strong>연결된 데이터가 없습니다.</strong><p>카탈로그에서 이 업무 모델이 사용할 데이터를 선택해 주세요.</p><Button type="button" onClick={() => setPickerOpen(true)}><Plus /> 데이터 선택</Button></Card> : <div className="semantic-real-connected-list">{datasets.map((dataset) => {
      const source = catalogDatasets.find((item) => item.id === dataset.datasetId);
      const columnCount = schemaFor(dataset, catalogDatasets).length;
      return <Card key={dataset.datasetId} size="none" className="semantic-real-connected-card">
        <div className="semantic-real-connected-head"><span className="semantic-real-connected-icon"><Database /></span><div><strong>{source?.name ?? dataset.name ?? dataset.datasetId}</strong><small>{source?.layer ?? dataset.layer ?? "CATALOG"} · {source?.rows ?? dataset.rows ?? "행 수 미상"} · 컬럼 {columnCount}개</small></div><Button variant="ghost" type="button" onClick={() => { toggle(dataset.datasetId); setPickerOpen(true); }}><Trash2 /> 연결 해제</Button></div>
        <SchemaCard dataset={dataset} catalogDatasets={catalogDatasets} />
      </Card>;
    })}</div>}
    {pickerOpen && <Card size="none" className="semantic-real-dataset-chooser">
      <div className="semantic-real-card-heading"><div><span className="semantic-real-eyebrow">CATALOG DATASETS</span><h3>사용할 데이터 선택</h3><p>질문에 함께 사용해야 하는 데이터만 선택하세요.</p></div><Badge variant="muted">{datasets.length}개 선택</Badge></div>
      <div className="semantic-real-dataset-picker">{catalogDatasets.map((dataset) => { const connected = datasets.some((item) => item.datasetId === dataset.id); return <label key={dataset.id} className={connected ? "selected" : ""}><Checkbox aria-label={`${dataset.name} Dataset 선택`} checked={connected} onCheckedChange={() => toggle(dataset.id)} /><Database size={16} /><span><strong>{dataset.name}</strong><small>{dataset.layer} · {dataset.rows} · {dataset.schema.length}개 컬럼</small></span></label>; })}</div>
      {catalogDatasets.length === 0 && <p className="semantic-real-inline-empty">연결할 수 있는 Catalog Dataset이 없습니다.</p>}
      <div className="semantic-real-chooser-actions"><Button variant="ghost" type="button" onClick={cancel}>취소</Button><Button type="button" disabled={!hasChanges || datasets.length === 0} onClick={() => void save()}><Save /> 선택 저장</Button></div>
    </Card>}
  </div>;
}

function SchemaCard({ dataset, catalogDatasets }: { dataset: SemanticDataset; catalogDatasets: CatalogDataset[] }) {
  const schema = schemaFor(dataset, catalogDatasets);
  return <section className="semantic-real-schema-block" aria-label={`${dataset.name ?? dataset.datasetId} 실제 스키마`}>
    <div className="semantic-real-schema-heading"><span><Table2 /> 실제 스키마</span><Badge variant="muted">컬럼 {schema.length}개</Badge></div>
    {schema.length > 0 ? <div className="semantic-real-schema-table"><Table>
      <TableHeader><TableRow><TableHead>컬럼</TableHead><TableHead>타입</TableHead><TableHead>샘플 값</TableHead></TableRow></TableHeader>
      <TableBody>{schema.map((column) => <TableRow key={column.name}><TableCell><code>{column.name}</code></TableCell><TableCell>{column.dataType}</TableCell><TableCell><small>{uniqueDisplayValues(column.sampleValues ?? []).slice(0, 2).join(" · ") || "샘플 없음"}</small></TableCell></TableRow>)}</TableBody>
    </Table></div> : <p className="semantic-real-inline-empty">백엔드 Catalog에 표시할 스키마 컬럼이 없습니다.</p>}
  </section>;
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
  return /(^|\b)(byte|short|long|tinyint|smallint|int|int8|int16|int32|int64|integer|bigint|float|float32|float64|double|decimal|numeric|number|real)(\b|\()/i.test(dataType);
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
    <div className="semantic-real-tab-content semantic-real-analysis-content">
      <SectionTitle title="분석 기준" description="계산할 값과 결과를 나눠볼 기준을 한 화면에서 설정합니다." />
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
        eyebrow="METRICS"
        title="계산 규칙"
        titleId="semantic-calculated-values-title"
        action={<div className="semantic-real-definition-actions"><Button variant="outline" type="button" onClick={add}><Plus /> 규칙 추가</Button><Button type="button" onClick={() => void onSave(metrics)}><Save /> 변경사항 저장</Button></div>}
      />
      {metrics.length === 0 ? <DefinitionEmptyState title="등록된 계산 규칙이 없습니다." onAdd={add} buttonLabel="첫 계산 규칙 추가" /> : <div className="semantic-real-definition-list">{metrics.map((metric) => <Card key={metric.id} className="semantic-real-definition-card" size="none">
        <div className="semantic-real-definition-card-header"><strong>{metric.label || "이름 없는 계산 규칙"}</strong><Button variant="ghost" type="button" aria-label={`${metric.label || metric.name} 삭제`} onClick={() => remove(metric.id)}><Trash2 /> 삭제</Button></div>
        <div className="semantic-real-definition-main">
          <label>사용자가 부를 이름<Input value={metric.label} onChange={(event) => update(metric.id, { label: event.target.value })} aria-label={`${metric.name} 표시명`} /></label>
          <label>실제 계산식<Input value={metric.expression} onChange={(event) => update(metric.id, { expression: event.target.value })} aria-label={`${metric.name} 계산식`} /></label>
        </div>
        <PhysicalColumnPicker model={model} catalogDatasets={catalogDatasets} datasetId={metric.datasetId ?? ""} selectedColumns={metric.sourceColumns} onDatasetChange={(datasetId) => update(metric.id, { datasetId, sourceColumns: [] })} onColumnsChange={(sourceColumns) => update(metric.id, { sourceColumns })} />
        <details className="semantic-real-advanced-setting"><summary>고급 설정 <ChevronDown /></summary><div><label>시스템 이름<Input value={metric.name} onChange={(event) => update(metric.id, { name: technicalName(event.target.value, metric.name) })} aria-label={`${metric.name} 내부 이름`} /></label><label>설명<Input value={metric.description} onChange={(event) => update(metric.id, { description: event.target.value })} aria-label={`${metric.name} 설명`} /></label></div></details>
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
        eyebrow="DIMENSIONS"
        title="분류 기준"
        titleId="semantic-grouping-fields-title"
        action={<div className="semantic-real-definition-actions"><Button variant="outline" type="button" disabled={!hasAvailableColumn} onClick={add}><Plus /> 기준 추가</Button><Button type="button" onClick={() => void onSave(dimensions)}><Save /> 변경사항 저장</Button></div>}
      />
      {dimensions.length === 0 ? <DefinitionEmptyState title="등록된 분류 기준이 없습니다." description={hasAvailableColumn ? undefined : "먼저 데이터 선택 단계에서 Dataset을 연결하세요."} onAdd={add} buttonLabel="첫 분류 기준 추가" disabled={!hasAvailableColumn} /> : <div className="semantic-real-definition-list">{dimensions.map((dimension) => <Card key={dimension.id} className="semantic-real-definition-card" size="none">
        <div className="semantic-real-definition-card-header"><strong>{dimension.label || "이름 없는 기준"}</strong><Button variant="ghost" type="button" aria-label={`${dimension.label || dimension.name} 삭제`} onClick={() => remove(dimension.id)}><Trash2 /> 삭제</Button></div>
        <div className="semantic-real-definition-main">
          <label>사용자가 부를 이름<Input value={dimension.label} onChange={(event) => update(dimension.id, { label: event.target.value })} aria-label={`${dimension.name} 표시명`} /></label>
          <label>설명<Input value={dimension.description} onChange={(event) => update(dimension.id, { description: event.target.value })} aria-label={`${dimension.name} 설명`} /></label>
        </div>
        <PhysicalColumnPicker model={model} catalogDatasets={catalogDatasets} datasetId={dimension.datasetId ?? ""} selectedColumns={dimension.columnName ? [dimension.columnName] : []} single inputName={`dimension-schema-${dimension.id}`} onDatasetChange={(datasetId) => update(dimension.id, { datasetId, columnName: "", dataType: "" })} onColumnsChange={(columns) => { const column = schemaFor(modelDataset(model, dimension.datasetId), catalogDatasets).find((item) => item.name === columns[0]); update(dimension.id, { columnName: columns[0] ?? "", dataType: column?.dataType ?? "" }); }} />
        <details className="semantic-real-advanced-setting"><summary>고급 설정 <ChevronDown /></summary><div><label>시스템 이름<Input value={dimension.name} onChange={(event) => update(dimension.id, { name: technicalName(event.target.value, dimension.name) })} aria-label={`${dimension.name} 내부 이름`} /></label></div></details>
      </Card>)}</div>}
    </section>
  );
}

function DefinitionEmptyState({ title, description, onAdd, buttonLabel, disabled = false }: { title: string; description?: string; onAdd: () => void; buttonLabel: string; disabled?: boolean }) {
  return <Card size="none" className="semantic-real-definition-empty"><Plus /><strong>{title}</strong>{description && <p>{description}</p>}<Button variant="outline" type="button" disabled={disabled} onClick={onAdd}><Plus /> {buttonLabel}</Button></Card>;
}

function PhysicalColumnPicker({ model, catalogDatasets, datasetId, selectedColumns, single = false, inputName, onDatasetChange, onColumnsChange }: { model: SemanticModel; catalogDatasets: CatalogDataset[]; datasetId: string; selectedColumns: string[]; single?: boolean; inputName?: string; onDatasetChange: (datasetId: string) => void; onColumnsChange: (columns: string[]) => void }) {
  const dataset = model.datasets.find((item) => item.datasetId === datasetId);
  const schema = schemaFor(dataset, catalogDatasets);
  const changeColumn = (columnName: string, checked: boolean) => {
    onColumnsChange(single
      ? [columnName]
      : checked
        ? [...selectedColumns, columnName]
        : selectedColumns.filter((item) => item !== columnName));
  };
  return <div className="semantic-real-binding">
    <label>원본 Dataset<Select value={datasetId || "__none__"} onValueChange={(value) => onDatasetChange(value === "__none__" ? "" : value)}><SelectTrigger aria-label="원본 Dataset" className="semantic-real-binding-select" size="lg"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="__none__">선택하세요</SelectItem>{model.datasets.map((item) => <SelectItem key={item.datasetId} value={item.datasetId}>{item.name ?? item.datasetId}</SelectItem>)}</SelectContent></Select></label>
    <div>
      <span>실제 schema 컬럼</span>
      {schema.length > 0 ? <div className="semantic-real-column-table"><Table>
        <TableHeader><TableRow><TableHead aria-label="선택" /><TableHead>컬럼</TableHead><TableHead>타입</TableHead><TableHead>샘플</TableHead></TableRow></TableHeader>
        <TableBody>{schema.map((column) => { const selected = selectedColumns.includes(column.name); return <TableRow key={column.name} className={selected ? "selected" : ""}>
          <TableCell>{single ? <input type="radio" name={inputName ?? `schema-${datasetId}`} aria-label={`${column.name} 컬럼 선택`} checked={selected} onChange={(event) => changeColumn(column.name, event.target.checked)} /> : <Checkbox aria-label={`${column.name} 컬럼 선택`} checked={selected} onCheckedChange={(checked) => changeColumn(column.name, checked === true)} />}</TableCell>
          <TableCell><code>{column.name}</code></TableCell>
          <TableCell>{column.dataType}</TableCell>
          <TableCell><small>{column.sampleValues.slice(0, 2).join(" · ") || "—"}</small></TableCell>
        </TableRow>; })}</TableBody>
      </Table></div> : <p className="semantic-real-inline-empty">표시할 스키마 컬럼이 없습니다.</p>}
    </div>
  </div>;
}

type SensitiveEmbeddingConfirmation = {
  column: string;
  role: "identifier" | "metadata";
};

const RAG_APPROVAL_COLUMN_LIMIT = 256;

function isSensitiveRagRole(role: string): role is SensitiveEmbeddingConfirmation["role"] {
  return role === "identifier" || role === "metadata";
}

function RagTab({ model, selectedDatasetId, profile, previewDocuments, jobsRefreshToken, onDatasetChange, onRefresh, onClassify, onApprove, onIndex, busy }: { model: SemanticModel; selectedDatasetId: string; profile?: RagProfile; previewDocuments: RagDocument[]; jobsRefreshToken: number; onDatasetChange: (id: string) => void; onRefresh: () => void; onClassify: () => void; onApprove: (roles: RagRolePayload) => void; onIndex: () => void; busy: string | null }) {
  const [roles, setRoles] = useState<Record<string, string>>({});
  const [embeddedColumns, setEmbeddedColumns] = useState<Record<string, boolean>>({});
  const [pendingSensitiveEmbedding, setPendingSensitiveEmbedding] = useState<SensitiveEmbeddingConfirmation | null>(null);
  const [pendingWholeDocumentEmbedding, setPendingWholeDocumentEmbedding] = useState(false);
  useEffect(() => {
    setPendingSensitiveEmbedding(null);
    setPendingWholeDocumentEmbedding(false);
    if (!profile || profile.datasetId !== selectedDatasetId) {
      setRoles({});
      setEmbeddedColumns({});
      return;
    }
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
  }, [profile, selectedDatasetId]);
  const schema = profile?.schema ?? modelDataset(model, selectedDatasetId)?.schema ?? [];
  const selectRole = (column: string, role: string) => {
    setPendingWholeDocumentEmbedding(false);
    setRoles((current) => ({ ...current, [column]: role }));
    setEmbeddedColumns((current) => ({
      ...current,
      [column]: role === "body" || role === "title",
    }));
    setPendingSensitiveEmbedding((current) => current?.column === column ? null : current);
  };
  const isColumnEmbedded = (column: string) => {
    const role = roles[column] ?? "excluded";
    return role === "body" || role === "title" || (role !== "excluded" && Boolean(embeddedColumns[column]));
  };
  const schemaLimitExceeded = schema.length > RAG_APPROVAL_COLUMN_LIMIT;
  const includeSafeDocumentFields = () => {
    if (schemaLimitExceeded) return;
    setPendingSensitiveEmbedding(null);
    setPendingWholeDocumentEmbedding(false);
    setEmbeddedColumns(Object.fromEntries(schema.map((column) => {
      const role = roles[column.name] ?? "excluded";
      return [column.name, role === "body" || role === "title"];
    })));
  };
  const requestWholeDocumentEmbedding = () => {
    if (schemaLimitExceeded) return;
    setPendingSensitiveEmbedding(null);
    setPendingWholeDocumentEmbedding(true);
  };
  const confirmWholeDocumentEmbedding = () => {
    setRoles((current) => Object.fromEntries(schema.map((column) => {
      const role = current[column.name] ?? "excluded";
      return [column.name, role === "excluded" ? "body" : role];
    })));
    setEmbeddedColumns(Object.fromEntries(schema.map((column) => [column.name, true])));
    setPendingWholeDocumentEmbedding(false);
  };
  const requestEmbeddingChange = (column: string, role: string, checked: boolean) => {
    setPendingWholeDocumentEmbedding(false);
    if (!checked) {
      setEmbeddedColumns((current) => ({ ...current, [column]: false }));
      setPendingSensitiveEmbedding((current) => current?.column === column ? null : current);
      return;
    }
    if (isSensitiveRagRole(role)) {
      setPendingSensitiveEmbedding({ column, role });
      return;
    }
    setEmbeddedColumns((current) => ({ ...current, [column]: true }));
  };
  const confirmSensitiveEmbedding = () => {
    if (!pendingSensitiveEmbedding) return;
    const { column, role } = pendingSensitiveEmbedding;
    if (roles[column] === role) setEmbeddedColumns((current) => ({ ...current, [column]: true }));
    setPendingSensitiveEmbedding(null);
  };
  const approveWithRoles = () => {
    if (!profile || schemaLimitExceeded) return;
    onApprove({
      bodyColumns: uniqueDisplayValues(schema.filter((column) => {
        const role = roles[column.name];
        return role === "body" || (isColumnEmbedded(column.name) && role !== "title" && role !== "excluded");
      }).map((column) => column.name)),
      titleColumns: uniqueDisplayValues(schema.filter((column) => roles[column.name] === "title").map((column) => column.name)),
      metadataColumns: uniqueDisplayValues(schema.filter((column) => roles[column.name] === "metadata").map((column) => column.name)),
      identifierColumns: uniqueDisplayValues(schema.filter((column) => roles[column.name] === "identifier").map((column) => column.name)),
      excludedColumns: uniqueDisplayValues(schema.filter((column) => roles[column.name] === "excluded").map((column) => column.name)),
    });
  };
  const hasServingIndex = profile?.servingStatus === "serving" || profile?.servingStatus === "stale";
  const hasEmbeddingBody = schema.some((column) => {
    const role = roles[column.name];
    return role === "body" || (isColumnEmbedded(column.name) && role !== "title" && role !== "excluded");
  });
  const hasIdentifier = schema.some((column) => roles[column.name] === "identifier");
  const embeddedFieldCount = schema.filter((column) => isColumnEmbedded(column.name)).length;
  if (!selectedDatasetId) return <div className="semantic-real-tab-content"><SectionTitle title="AI가 문장 속 근거를 찾게 합니다." /><Card size="none" className="semantic-real-definition-empty"><Database /><strong>연결된 데이터가 없습니다.</strong><p>1단계 데이터 선택에서 Dataset을 연결한 뒤 다시 확인해 주세요.</p></Card></div>;
  return <div className="semantic-real-tab-content">
    <SectionTitle title="AI가 문장 속 근거를 찾게 합니다." action={<Button variant="outline" type="button" disabled={!selectedDatasetId || busy !== null} onClick={onRefresh}><RefreshCw /> 상태 새로고침</Button>} />
    {model.datasets.length > 1 ? <div className="semantic-real-rag-dataset-switcher">{model.datasets.map((dataset) => <Button variant="outline" type="button" key={dataset.datasetId} className={dataset.datasetId === selectedDatasetId ? "active" : ""} onClick={() => onDatasetChange(dataset.datasetId)}><Database size={16} /><span><strong>{dataset.name ?? dataset.datasetId}</strong><small>{statusLabel(profile?.datasetId === dataset.datasetId ? profile.reviewState : "not_configured")}</small></span></Button>)}</div> : <div className="semantic-real-rag-context"><Database /><span><strong>{model.datasets[0]?.name ?? selectedDatasetId}</strong><small>이 데이터에서 문장 근거를 찾습니다.</small></span></div>}
    {!profile ? <Card size="none" className="semantic-real-rag-empty"><Sparkles /><strong>AI 검색을 아직 준비하지 않았습니다.</strong><p>AI가 컬럼을 살펴보고 검색할 문장과 식별자를 먼저 추천합니다.</p><Button type="button" disabled={busy !== null} onClick={onClassify}><Sparkles /> 검색할 내용 자동 추천</Button></Card> : <>
      <div className="semantic-real-rag-progress" aria-label="AI 검색 준비 상태">
        <span className={profile.reviewState === "approved" ? "complete" : "active"}><em>1</em><span><strong>검색할 내용</strong><small>{statusLabel(profile.reviewState)}</small></span></span>
        <span className={hasServingIndex ? "complete" : profile.reviewState === "approved" ? "active" : ""}><em>2</em><span><strong>검색 데이터</strong><small>{hasServingIndex ? "준비됨" : statusLabel(profile.indexStatus)}</small></span></span>
        <span className={hasServingIndex ? "active" : ""}><em>3</em><span><strong>근거 검색</strong><small>{hasServingIndex ? "사용 가능" : "준비 후 사용"}</small></span></span>
      </div>
      {hasServingIndex && <RagSearchPanel datasetId={selectedDatasetId} profile={profile} />}
      <details className="semantic-real-rag-setup" open={!hasServingIndex}>
        <summary><span><strong>검색할 컬럼 설정</strong><small>{embeddedFieldCount}개 컬럼을 AI가 읽도록 선택했습니다.</small></span><span><Badge variant={profile.reviewState === "approved" ? "success" : "warning"}>{statusLabel(profile.reviewState)}</Badge><ChevronDown /></span></summary>
        <div className="semantic-real-rag-setup-body">
          <div className="semantic-real-card-heading"><div><h3>AI가 읽을 내용 확인</h3><p>선택한 모든 필드는 필드명과 함께 한 문서로 합쳐진 뒤 청킹·임베딩됩니다.</p></div><div className="semantic-real-role-heading-actions"><Button variant="outline" type="button" disabled={schemaLimitExceeded} onClick={includeSafeDocumentFields}><FileText /> 제목·본문만 포함</Button><Button variant="outline" type="button" disabled={schemaLimitExceeded} onClick={requestWholeDocumentEmbedding}><FileText /> 문서 전체 임베딩</Button><Button variant="outline" type="button" disabled={busy !== null} onClick={onClassify}><RefreshCw /> 다시 추천</Button></div></div>
          <div className="semantic-real-embedding-guide"><strong>AI가 읽을 컬럼 {embeddedFieldCount}개</strong><span>제목·본문만 포함은 식별자와 필터 값을 검색 본문에서 제외합니다. 문서 전체 임베딩은 확인 후 모든 컬럼을 포함합니다.</span><span className="is-warning"><AlertTriangle size={16} /> 식별자·필터 값을 임베딩하면 이메일, 전화번호, 계정 ID 같은 민감정보가 VectorDB 검색 결과에 노출될 수 있습니다.</span>{schemaLimitExceeded && <span className="is-warning" role="alert">현재 스키마는 {schema.length}개 컬럼으로 안전 상한 {RAG_APPROVAL_COLUMN_LIMIT}개를 초과했습니다. 전체 포함과 역할 승인을 차단했습니다.</span>}{!hasIdentifier && <span className="is-warning">원본 행을 구분할 식별자를 하나 선택해 주세요.</span>}</div>
          <div className="semantic-real-role-table"><div className="header"><span>컬럼</span><span>타입</span><span>추천 이유</span><span>검색에서의 역할</span><span>본문 포함</span></div>{schema.map((column) => {
            const role = roles[column.name] ?? "excluded";
            const recommendation = profile.recommendations.find((item) => item.columnName === column.name);
            const alwaysEmbedded = role === "body" || role === "title";
            const cannotEmbed = role === "excluded";
            const sensitiveEmbedding = isSensitiveRagRole(role);
            const embedded = isColumnEmbedded(column.name);
            return <div key={column.name}><code>{column.name}</code><span>{column.dataType}</span><small>{recommendation?.reason ?? "분석 기준 또는 사용자 선택"}</small><Select value={role} onValueChange={(value) => selectRole(column.name, value)}><SelectTrigger aria-label={`${column.name} 검색 역할`} className="semantic-real-role-select" size="sm"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="body">검색할 문장</SelectItem><SelectItem value="title">문서 제목</SelectItem><SelectItem value="metadata">필터 조건</SelectItem><SelectItem value="identifier">행 식별자</SelectItem><SelectItem value="excluded">사용 안 함</SelectItem></SelectContent></Select><label className="semantic-real-embedding-toggle"><Checkbox checked={embedded} disabled={alwaysEmbedded || cannotEmbed} onCheckedChange={(checked) => requestEmbeddingChange(column.name, role, checked === true)} /><span>{cannotEmbed ? "제외됨" : alwaysEmbedded ? "자동 포함" : sensitiveEmbedding ? embedded ? "민감 필드 포함됨" : "확인 후 포함" : "함께 읽기"}</span></label></div>;
          })}</div>
          {pendingSensitiveEmbedding && <div className="semantic-real-embedding-confirmation" role="alert"><AlertTriangle size={18} /><div><strong><code>{pendingSensitiveEmbedding.column}</code> 필드를 검색 본문에 포함할까요?</strong><span>이 값은 VectorDB에 저장되고 유사도 검색 결과에 노출될 수 있습니다.</span></div><Button type="button" onClick={confirmSensitiveEmbedding}>위험을 이해하고 포함</Button><Button variant="outline" type="button" onClick={() => setPendingSensitiveEmbedding(null)}>취소</Button></div>}
          {pendingWholeDocumentEmbedding && <div className="semantic-real-embedding-confirmation" role="alert"><AlertTriangle size={18} /><div><strong>현재 스키마의 {schema.length}개 컬럼을 모두 임베딩할까요?</strong><span>제외 컬럼은 검색 본문으로 바뀌고 식별자·필터 값도 VectorDB에 저장됩니다.</span></div><Button type="button" onClick={confirmWholeDocumentEmbedding}>위험을 이해하고 전체 포함</Button><Button variant="outline" type="button" onClick={() => setPendingWholeDocumentEmbedding(false)}>취소</Button></div>}
          <div className="semantic-real-rag-actions"><Button variant="outline" type="button" disabled={busy !== null || !hasEmbeddingBody || !hasIdentifier || schemaLimitExceeded} onClick={approveWithRoles}><ShieldCheck /> 검색할 내용 확정</Button><Button type="button" disabled={busy !== null || profile.reviewState !== "approved"} onClick={onIndex}>{hasServingIndex ? <RefreshCw /> : <Check />} {hasServingIndex ? "검색 데이터 업데이트" : "AI 검색 시작"}</Button></div>
        </div>
      </details>
      <RagJobHistory datasetId={selectedDatasetId} refreshToken={jobsRefreshToken} onLatestJobSettled={onRefresh} />
      <details className="semantic-real-technical-details"><summary><span><strong>실제 적재 문서 확인</strong><small>어떤 문자열이 임베딩되는지 원문 기준으로 확인합니다.</small></span><ChevronDown /></summary><div><DocumentPreview profile={profile} documents={previewDocuments} /></div></details>
    </>}
  </div>;
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
          <span className="semantic-real-eyebrow">TRY AI SEARCH</span>
          <h3>AI 검색 테스트</h3>
          <p>실제 질문을 입력해 어떤 원문이 근거로 찾아지는지 확인하세요.</p>
        </div>
        <Badge variant={searchReady ? "success" : "warning"}>{searchReady ? "사용 가능" : "준비 필요"}</Badge>
      </div>
      <form className="semantic-real-rag-search-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <Input
          aria-label="RAG 검색 질문"
          disabled={!searchReady || searching}
          placeholder={searchReady ? "예: 배송이 늦어서 불만인 고객 리뷰" : "검색할 내용을 확정하고 AI 검색을 시작해 주세요."}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button type="submit" disabled={!searchReady || searching || !query.trim()}>
          {searching ? <Loader2 className="semantic-spin" /> : <Search />} 근거 찾기
        </Button>
      </form>
      {!searchReady && <p className="semantic-real-rag-search-guidance">검색할 내용을 확정하고 검색 데이터를 준비하면 사용할 수 있습니다.</p>}
      {profile.servingStatus === "stale" && <div className="semantic-real-rag-search-error" role="status"><AlertTriangle />데이터가 바뀌었습니다. 검색은 가능하지만 검색 데이터를 업데이트해야 최신 내용이 반영됩니다.</div>}
      {searchError && <div className="semantic-real-rag-search-error" role="alert"><AlertTriangle />{searchError}</div>}
      {result && <RagSearchResults result={result} />}
    </Card>
  );
}

function RagSearchResults({ result }: { result: RagSearchResponse }) {
  const resultCount = typeof result.retrieval.resultCount === "number" ? result.retrieval.resultCount : result.sources.length;
  const aliasValues = uniqueDisplayValues(Array.isArray(result.retrieval.aliases) ? result.retrieval.aliases : []);
  const aliases = aliasValues.join(", ");
  const servingIndex = String(result.retrieval.servingIndex ?? "").trim();
  const retrievalStatus = String(result.retrieval.status ?? "complete");
  const filterLabels = uniqueDisplayValues(ragAppliedFilterLabels(result.retrieval.filters));
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
        {servingIndex && !aliasValues.includes(servingIndex) && <code>{servingIndex}</code>}
        {(result.retrieval.queryPlannerProvider || result.retrieval.queryPlannerModel) && <code>검색 계획 {uniqueDisplayValues([result.retrieval.queryPlannerProvider, result.retrieval.queryPlannerModel]).join(" · ")}</code>}
        {queryEmbeddings.map(([datasetId, embedding]) => <code key={`query-embedding-${datasetId}`}>쿼리 임베딩 {datasetId} · {uniqueDisplayValues([embedding.provider, embedding.model, embedding.dimensions ? `${embedding.dimensions}차원` : null]).join(" · ")}</code>)}
        {(result.retrieval.relevanceProvider || result.retrieval.relevanceModel) && <code>관련성 검증 {uniqueDisplayValues([result.retrieval.relevanceProvider, result.retrieval.relevanceModel]).join(" · ")}</code>}
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
            {source.fallbackApplied && <small>청킹 방식: {uniqueDisplayValues(source.chunkingStrategies ?? [source.chunkingStrategy]).join(", ") || "semantic_embedding_fallback"} · 사유: {uniqueDisplayValues(source.fallbackReasons ?? [source.fallbackReason]).join(", ") || "경계 조정 응답 검증 실패"}</small>}
            {Object.keys(source.metadata ?? {}).length > 0 && <dl>{Object.entries(source.metadata).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl>}
            <footer><code>{source.documentId}</code>{source.sourceRowId && <span>원본 행 {source.sourceRowId}</span>}{(source.embeddingProvider || source.embeddingModel) && <span>임베딩 {uniqueDisplayValues([source.embeddingProvider, source.embeddingModel, source.embeddingDimensions ? `${source.embeddingDimensions}차원` : null]).join(" · ")}</span>}{source.chunkingVersion && <span>청킹 {source.chunkingVersion}</span>}{source.sourceFields?.length > 0 && <span>필드 {ragSourceFieldSummary(source.sourceFields)}</span>}</footer>
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

function uniqueDisplayValues(values: readonly unknown[]) {
  const seen = new Set<string>();
  return values.flatMap((value) => {
    if (value === null || value === undefined) return [];
    const label = String(value).trim();
    if (!label || seen.has(label)) return [];
    seen.add(label);
    return [label];
  });
}

function ragSourceFieldSummary(fields: Array<string | { logicalField?: string; physicalField?: string; role?: string }>) {
  return uniqueDisplayValues(fields.map(ragSourceFieldLabel)).join(", ");
}

function DocumentPreview({ profile, documents }: { profile: RagProfile; documents: RagDocument[] }) {
  const servingReady = profile.servingStatus === "serving" || profile.servingStatus === "stale";
  return <Card size="none" className="semantic-real-document-card"><div className="semantic-real-card-heading"><div><span className="semantic-real-eyebrow">DOCUMENT PREVIEW</span><h3>VectorDB에 들어간 실제 문서</h3><p>임베딩 숫자 배열 대신, 어떤 필드가 어떤 문자열로 합쳐져 임베딩되는지 직접 확인합니다.</p></div><Badge variant={servingReady ? "success" : "muted"}>{statusLabel(servingReady ? profile.servingStatus ?? "serving" : profile.embeddingStatus)}</Badge></div>{documents.length === 0 ? <div className="semantic-real-document-empty"><FileText /><span>승인 후 실제 적재 문서가 표시됩니다.</span></div> : <div className="semantic-real-documents">{documents.map((document) => <article key={document.documentId}><div className="semantic-real-document-head"><code>{document.sourceRowId}</code><Badge size="sm">{statusLabel(document.embeddingStatus)}</Badge></div>{document.title && <strong>{document.title}</strong>}<p>{document.body}</p><div>{Object.entries(document.metadataDisplay).map(([key, value]) => <span key={key}><code>{key}</code>{String(value)}</span>)}</div>{document.embeddingText && <details className="semantic-real-embedding-preview"><summary>실제 임베딩 입력 보기</summary><pre>{document.embeddingText}</pre></details>}<small>{document.sourceDataset} · {uniqueDisplayValues(document.sourceColumns).join(", ")} → {document.targetIndex}</small></article>)}</div>}</Card>;
}

function AccessTab({ model }: { model: SemanticModel }) {
  return <div className="semantic-real-tab-content"><SectionTitle title="접근 권한" /><Card size="none" className="semantic-real-access-card">{model.permissionGrants.length ? model.permissionGrants.map((grant) => <div key={`${grant.principalType}-${grant.principalId}`}><ShieldCheck /><strong>{grant.principalId}</strong><span>{grant.principalType}</span><div>{grant.actions.map((action) => <Badge key={action} size="sm">{action}</Badge>)}</div></div>) : <p>등록된 권한 규칙이 없습니다.</p>}</Card></div>;
}

function SectionTitle({ eyebrow, title, titleId, description, action }: { eyebrow?: string; title: string; titleId?: string; description?: string; action?: ReactNode }) {
  return <div className="semantic-real-section-title"><div>{eyebrow && <span className="semantic-real-eyebrow">{eyebrow}</span>}<h2 id={titleId}>{title}</h2>{description && <p>{description}</p>}</div>{action}</div>;
}

function CreateModelPanel({ datasets, busy, onCancel, onCreate }: { datasets: CatalogDataset[]; busy: boolean; onCancel: () => void; onCreate: (name: string, description: string, datasetIds: string[]) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  return <Card size="none" className="semantic-real-create"><div><span className="semantic-real-eyebrow">NEW SEMANTIC MODEL</span><h2>실제 DB에 업무 모델 생성</h2></div><Input value={name} onChange={(event) => setName(event.target.value)} placeholder="업무 모델 이름" /><Textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="이 모델이 어떤 업무 기준을 묶는지 설명" rows={3} /><div className="semantic-real-create-datasets">{datasets.map((dataset) => { const checked = selectedIds.includes(dataset.id); return <label key={dataset.id}><Checkbox aria-label={`${dataset.name} Dataset 선택`} checked={checked} onCheckedChange={(nextChecked) => setSelectedIds((current) => nextChecked === true ? (current.includes(dataset.id) ? current : [...current, dataset.id]) : current.filter((id) => id !== dataset.id))} /><span>{dataset.name}<small>{dataset.schema.length}개 컬럼 · {dataset.rows}</small></span></label>; })}</div><div><Button variant="outline" type="button" onClick={onCancel}>취소</Button><Button disabled={busy || !name.trim() || selectedIds.length === 0} type="button" onClick={() => onCreate(name.trim(), description, selectedIds)}>{busy ? <Loader2 className="semantic-spin" /> : <Plus />} 생성</Button></div></Card>;
}

function EmptyModelState({ onCreate }: { onCreate: () => void }) {
  return <Card size="none" className="semantic-real-empty-model"><Database /><h2>실제 업무 모델이 없습니다.</h2><p>Catalog Dataset을 선택해 첫 업무 모델을 실제 DB에 생성하세요.</p><Button type="button" onClick={onCreate}><Plus /> 업무 모델 생성</Button></Card>;
}
