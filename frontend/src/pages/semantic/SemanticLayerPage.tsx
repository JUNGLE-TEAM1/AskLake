import { useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { AlertTriangle, ArrowRight, Check, ChevronDown, Database, Loader2, Pencil, Plus, RefreshCw, Save, ShieldCheck, Table2, Trash2, X } from "lucide-react";
import type { CatalogDataset } from "../../types";
import type { AuditResult } from "../../types/audit";
import {
  createSemanticModel,
  listSemanticModels,
  publishSemanticModel,
  replaceSemanticDimensions,
  replaceSemanticMetrics,
  replaceSemanticDatasets,
  updateSemanticModel,
  validateSemanticModel,
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
import { Input } from "../../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { Textarea } from "../../components/ui/textarea";
import "../../styles/semantic-layer-real.css";

type Tab = "datasets" | "analysis" | "access";
type Notice = { tone: "success" | "error" | "info"; message: string };

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

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    draft: "초안",
    published: "게시됨",
  };
  return labels[status] ?? status;
}

function semanticModelDisplayVersion(model: SemanticModel) {
  return model.status === "published" && model.publishedVersion != null
    ? model.publishedVersion
    : model.version;
}

type StateSetter<T> = Dispatch<SetStateAction<T>>;
type SemanticActionRunner = (key: string, action: () => Promise<void>) => Promise<boolean>;

function useSemanticWorkspaceData() {
  const [models, setModels] = useState<SemanticModel[]>([]);
  const [selectedModelId, setSelectedModelId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const nextModels = await listSemanticModels();
      setModels(nextModels);
      setSelectedModelId((current) => current && nextModels.some((model) => model.id === current) ? current : nextModels[0]?.id ?? "");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Semantic Model을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const selected = models.find((model) => model.id === selectedModelId) ?? models[0];
  return { error, load, loading, models, selected, setModels, setSelectedModelId };
}

function buildSemanticModelActions({ selected, run, setModels, setNotice, onAction }: {
  selected: SemanticModel | undefined;
  run: SemanticActionRunner;
  setModels: StateSetter<SemanticModel[]>;
  setNotice: StateSetter<Notice | null>;
  onAction: SemanticPageProps["onAction"];
}) {
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
  return { publishSelected, saveDatasets, saveDimensions, saveMetrics, saveModelInfo };
}

export function SemanticLayerPage({ datasets: providedDatasets, onAction }: SemanticPageProps) {
  const catalogDatasets = providedDatasets;
  const { error, load, loading, models, selected, setModels, setSelectedModelId } = useSemanticWorkspaceData();
  const [activeTab, setActiveTab] = useState<Tab>("datasets");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const busyRef = useRef(false);

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

  const { publishSelected, saveDatasets, saveDimensions, saveMetrics, saveModelInfo } = buildSemanticModelActions({
    onAction, run, selected, setModels, setNotice,
  });

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
    { id: "access", number: 3, title: "권한" },
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
