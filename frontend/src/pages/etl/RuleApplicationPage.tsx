import { useEffect, useMemo, useState } from "react";
import { runTransformQualitySamplePreview } from "../../data/transformQualityPreview";
import type { AuditResult, DraftPipeline, DraftPipelinePatch } from "../../types";

import {
  QualityRulesTable,
  RecipeStepsTable,
  RuleCategoryTabs,
  RuleMetrics,
  RuleStepBuilder
} from "./RuleEditorPanels";
import {
  buildDefaultQualityRules,
  buildDefaultRecipeSteps,
  buildTransformOutputColumns,
  createDefaultTransformQualityPreviewCache,
  createQualityRuleFromDraft,
  createRecipeStepFromDraft,
  formatInvalidRowsPreviewSummary,
  formatTransformSummary,
  getDerivedColumns,
  getPermanentQualityRules,
  getQualityRuleInvalidRows,
  getRuleDatasetId,
  getRuleSourceColumns,
  getRuleStats,
  getWorkingColumns,
  QUALITY_DRAFT_PREVIEW_ID_PREFIX,
  QualityRule,
  qualityRuleToRuleStepDraft,
  readTransformQualityPreviewCache,
  RecipeStep,
  recipeStepToRuleStepDraft,
  replaceOrAppendById,
  RuleCategory,
  RuleStepDraft,
  schemaRowsToRuleSampleRows,
  toDraftInvalidRows,
  toDraftQualityRules,
  toDraftTransformSteps,
  TRANSFORM_QUALITY_PREVIEW_CACHE_VERSION,
  writeTransformQualityPreviewCache
} from "./ruleModel";
import {
  FinalDatasetPreviewPanel,
  InvalidRowsPanel,
  QualityFailedRowsPanel,
  QualityPreviewAnalysis,
  RuleBottomBar,
  StepPreviewAnalysis
} from "./RulePreviewPanels";

export function RuleApplicationPage({
  draft,
  onDraftChange,
  onAction,
  onNotify,
  onNext,
  onPrev,
  onSave,
}: {
  draft: DraftPipeline;
  onDraftChange: (patch: DraftPipelinePatch) => void;
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onNotify: (message: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onSave: () => void;
}) {
  const ruleSampleRows = useMemo(() => schemaRowsToRuleSampleRows(draft.schema.columns, draft.schema.sampleRows), [draft.schema.columns, draft.schema.sampleRows]);
  const sourceColumns = useMemo(() => getRuleSourceColumns(draft.schema.columns), [draft.schema.columns]);
  const sourceColumnSet = useMemo(() => new Set(sourceColumns), [sourceColumns]);
  const datasetId = useMemo(() => getRuleDatasetId(draft), [draft]);
  const defaultRecipeSteps = useMemo(() => buildDefaultRecipeSteps(draft), [draft]);
  const defaultQualityRules = useMemo(() => buildDefaultQualityRules(draft), [draft]);
  const defaultPreviewCache = useMemo(() => {
    const validation = runTransformQualitySamplePreview(defaultRecipeSteps, defaultQualityRules, ruleSampleRows).validation;
    return createDefaultTransformQualityPreviewCache(datasetId, defaultRecipeSteps, defaultQualityRules, validation);
  }, [datasetId, defaultQualityRules, defaultRecipeSteps, ruleSampleRows]);
  const [previewCache] = useState(() => readTransformQualityPreviewCache(defaultPreviewCache));
  const [selectedRuleCategory, setSelectedRuleCategory] = useState<RuleCategory>("transform");
  const [recipeSteps, setRecipeSteps] = useState<RecipeStep[]>(previewCache.recipeSteps);
  const [qualityRules, setQualityRules] = useState<QualityRule[]>(previewCache.qualityRules);
  const [selectedPreviewStepId, setSelectedPreviewStepId] = useState(previewCache.selectedPreviewStepId);
  const [selectedQualityRuleId, setSelectedQualityRuleId] = useState(previewCache.selectedQualityRuleId);
  const [draftPreviewStep, setDraftPreviewStep] = useState<RecipeStep | null>(null);
  const [draftPreviewQualityRule, setDraftPreviewQualityRule] = useState<QualityRule | null>(null);
  const [editingTransformStepId, setEditingTransformStepId] = useState<string | null>(null);
  const [editingQualityRuleId, setEditingQualityRuleId] = useState<string | null>(null);
  const [showInvalidRows, setShowInvalidRows] = useState(false);
  const workingColumns = useMemo(() => getWorkingColumns(recipeSteps, sourceColumns), [recipeSteps, sourceColumns]);
  const derivedColumns = useMemo(() => getDerivedColumns(recipeSteps, sourceColumnSet), [recipeSteps, sourceColumnSet]);
  const runnerResult = useMemo(() => runTransformQualitySamplePreview(recipeSteps, qualityRules, ruleSampleRows), [qualityRules, recipeSteps, ruleSampleRows]);
  const previewRunnerResult = useMemo(() => {
    const previewSteps = draftPreviewStep?.id === selectedPreviewStepId ? replaceOrAppendById(recipeSteps, draftPreviewStep) : recipeSteps;
    return runTransformQualitySamplePreview(previewSteps, qualityRules, ruleSampleRows);
  }, [draftPreviewStep, qualityRules, recipeSteps, ruleSampleRows, selectedPreviewStepId]);
  const qualityPreviewRules = useMemo(() => (
    draftPreviewQualityRule?.id === selectedQualityRuleId ? replaceOrAppendById(qualityRules, draftPreviewQualityRule) : qualityRules
  ), [draftPreviewQualityRule, qualityRules, selectedQualityRuleId]);
  const qualityPreviewRunnerResult = useMemo(() => (
    draftPreviewQualityRule?.id === selectedQualityRuleId
      ? runTransformQualitySamplePreview(recipeSteps, qualityPreviewRules, ruleSampleRows)
      : runnerResult
  ), [draftPreviewQualityRule, qualityPreviewRules, recipeSteps, ruleSampleRows, runnerResult, selectedQualityRuleId]);
  const validationResult = runnerResult.validation;
  const invalidRows = validationResult.failedRows;
  const invalidRowCount = validationResult.invalidRowCount;
  const ruleStats = getRuleStats(recipeSteps, qualityRules, invalidRowCount, sourceColumns.length);
  const selectedPreviewStep = (draftPreviewStep?.id === selectedPreviewStepId ? draftPreviewStep : undefined)
    ?? recipeSteps.find((step) => step.id === selectedPreviewStepId)
    ?? recipeSteps[0]
    ?? defaultRecipeSteps[0];
  const selectedQualityRule = draftPreviewQualityRule?.id === selectedQualityRuleId
    ? draftPreviewQualityRule
    : qualityRules.find((rule) => rule.id === selectedQualityRuleId) ?? qualityRules[0] ?? defaultQualityRules[0];
  const selectedQualityInvalidRows = getQualityRuleInvalidRows(qualityPreviewRunnerResult.validation.failedRows, selectedQualityRule);
  const invalidRowsPreviewSummary = formatInvalidRowsPreviewSummary(invalidRowCount, invalidRows.length);
  const cachedSelectedQualityRuleId = qualityRules.some((rule) => rule.id === selectedQualityRuleId)
    ? selectedQualityRuleId
    : qualityRules[0]?.id ?? defaultQualityRules[0]?.id ?? "";
  const editingTransformStep = editingTransformStepId ? recipeSteps.find((step) => step.id === editingTransformStepId) ?? null : null;
  const editingQualityRule = editingQualityRuleId ? qualityRules.find((rule) => rule.id === editingQualityRuleId) ?? null : null;
  const editingDraft = useMemo(() => {
    if (selectedRuleCategory === "transform" && editingTransformStep) {
      return recipeStepToRuleStepDraft(editingTransformStep);
    }
    if (selectedRuleCategory === "quality" && editingQualityRule) {
      return qualityRuleToRuleStepDraft(editingQualityRule);
    }
    return null;
  }, [editingQualityRule, editingTransformStep, selectedRuleCategory]);
  const editingLabel = useMemo(() => {
    if (selectedRuleCategory === "transform" && editingTransformStep) {
      return `${recipeSteps.findIndex((step) => step.id === editingTransformStep.id) + 1}번 변환 단계`;
    }
    if (selectedRuleCategory === "quality" && editingQualityRule) {
      return `${qualityRules.findIndex((rule) => rule.id === editingQualityRule.id) + 1}번 품질 규칙`;
    }
    return undefined;
  }, [editingQualityRule, editingTransformStep, qualityRules, recipeSteps, selectedRuleCategory]);

  useEffect(() => {
    writeTransformQualityPreviewCache({
      datasetId,
      invalidRows,
      qualityRules,
      recipeSteps,
      selectedPreviewStepId,
      selectedQualityRuleId: cachedSelectedQualityRuleId,
      savedAt: new Date().toISOString(),
      validation: validationResult,
      version: TRANSFORM_QUALITY_PREVIEW_CACHE_VERSION,
    });
  }, [cachedSelectedQualityRuleId, datasetId, invalidRows, qualityRules, recipeSteps, selectedPreviewStepId, validationResult]);

  const buildRuleDraftPatch = (steps: RecipeStep[] = recipeSteps, rules: QualityRule[] = qualityRules): DraftPipelinePatch => {
    const nextRunnerResult = steps === recipeSteps && rules === qualityRules ? runnerResult : runTransformQualitySamplePreview(steps, rules, ruleSampleRows);
    const nextValidation = nextRunnerResult.validation;
    const nextStats = getRuleStats(steps, rules, nextValidation.invalidRowCount, sourceColumns.length);
    return {
      transform: {
        outputColumns: buildTransformOutputColumns(steps, draft.schema.columns, nextRunnerResult.transformedRows),
        steps: toDraftTransformSteps(steps),
        summary: formatTransformSummary(nextStats),
      },
      quality: {
        invalidRows: toDraftInvalidRows(nextValidation.failedRows),
        rules: toDraftQualityRules(rules),
        score: nextValidation.qualityScore,
        status: nextValidation.status,
        summary: nextValidation.summary,
      },
    };
  };

  const applyRuleDraft = (steps: RecipeStep[] = recipeSteps, rules: QualityRule[] = qualityRules) => {
    onDraftChange(buildRuleDraftPatch(steps, rules));
  };

  const testRules = () => {
    onAction("etl.transform.tested", "/api/etl/transform-rules/test", draft.source.sourceLabel || draft.target.datasetName || "rule-preview");
    applyRuleDraft();
    onNotify(`${ruleStats.totalRules}개 rule 샘플 테스트가 완료되었습니다.`);
  };

  const ruleAction = (action: string, path: string, targetId = draft.source.sourceLabel || draft.target.datasetName || "rule-preview") => {
    onAction(action, path, targetId);
  };

  const saveRuleDraft = () => {
    applyRuleDraft();
    onSave();
  };

  const goNext = () => {
    applyRuleDraft();
    onNext();
  };

  const previewRecipeStep = (step: RecipeStep) => {
    setDraftPreviewStep(null);
    setDraftPreviewQualityRule(null);
    setSelectedPreviewStepId(step.id);
    ruleAction("etl.rules.step_previewed", `/api/etl/rules/steps/${step.id}/preview`);
  };

  const editRecipeStep = (step: RecipeStep) => {
    setSelectedRuleCategory("transform");
    setEditingTransformStepId(step.id);
    setEditingQualityRuleId(null);
    setDraftPreviewStep(null);
    setDraftPreviewQualityRule(null);
    setSelectedPreviewStepId(step.id);
    ruleAction("etl.rules.step_edit_started", `/api/etl/rules/steps/${step.id}`);
  };

  const cancelRuleEdit = () => {
    setEditingTransformStepId(null);
    setEditingQualityRuleId(null);
    setDraftPreviewStep(null);
    setDraftPreviewQualityRule(null);
    ruleAction("etl.rules.edit_canceled", "/api/etl/rules/edit");
  };

  const removeRecipeStep = (step: RecipeStep) => {
    const nextSteps = recipeSteps.filter((currentStep) => currentStep.id !== step.id);
    if (nextSteps.length === 0) {
      onNotify("최소 1개 rule은 유지해야 합니다.");
      return;
    }
    setRecipeSteps(nextSteps);
    setDraftPreviewStep(null);
    setDraftPreviewQualityRule(null);
    if (editingTransformStepId === step.id) {
      setEditingTransformStepId(null);
    }
    if (!nextSteps.some((nextStep) => nextStep.id === selectedPreviewStepId)) {
      const removedIndex = recipeSteps.findIndex((currentStep) => currentStep.id === step.id);
      const nextSelectedStep = nextSteps[Math.min(Math.max(removedIndex, 0), nextSteps.length - 1)] ?? nextSteps[0];
      setSelectedPreviewStepId(nextSelectedStep.id);
    }
    applyRuleDraft(nextSteps);
    ruleAction("etl.rules.step_removed", `/api/etl/rules/steps/${step.id}`);
  };

  const addRecipeStep = (draft: RuleStepDraft) => {
    const nextStepNumber = String(Math.max(...recipeSteps.map((step) => Number(step.id)), 0) + 1);
    const nextStep = createRecipeStepFromDraft(draft, nextStepNumber);
    const nextSteps = [...recipeSteps, nextStep];
    setRecipeSteps(nextSteps);
    setDraftPreviewStep(null);
    setDraftPreviewQualityRule(null);
    setSelectedPreviewStepId(nextStep.id);
    applyRuleDraft(nextSteps);
    ruleAction("etl.rules.step_added", "/api/etl/rules/steps");
    onNotify("새 rule step이 추가되었습니다.");
  };

  const updateRecipeStep = (draft: RuleStepDraft) => {
    if (!editingTransformStepId) return;
    const currentStep = recipeSteps.find((step) => step.id === editingTransformStepId);
    if (!currentStep) {
      setEditingTransformStepId(null);
      onNotify("수정할 transform step을 찾을 수 없습니다.");
      return;
    }
    const updatedStep = createRecipeStepFromDraft(draft, editingTransformStepId, currentStep);
    const nextSteps = recipeSteps.map((step) => step.id === editingTransformStepId ? updatedStep : step);
    setRecipeSteps(nextSteps);
    setDraftPreviewStep(null);
    setDraftPreviewQualityRule(null);
    setEditingTransformStepId(null);
    setSelectedPreviewStepId(updatedStep.id);
    applyRuleDraft(nextSteps);
    ruleAction("etl.rules.step_updated", `/api/etl/rules/steps/${updatedStep.id}`);
    onNotify("rule step이 업데이트되었습니다.");
  };

  const addQualityRule = (draft: RuleStepDraft) => {
    const baseRules = getPermanentQualityRules(qualityRules);
    const nextRuleNumber = baseRules.length + 1;
    const nextRule = createQualityRuleFromDraft(draft, `qr-custom-${nextRuleNumber}`);
    const nextRules = [...baseRules, nextRule];
    setQualityRules(nextRules);
    setDraftPreviewQualityRule(null);
    setSelectedQualityRuleId(nextRule.id);
    applyRuleDraft(recipeSteps, nextRules);
    ruleAction("etl.rules.quality_rule_added", "/api/etl/rules/quality");
    onNotify("새 quality check가 추가되었습니다.");
  };

  const addRuleDraft = (draft: RuleStepDraft) => {
    if (selectedRuleCategory === "quality") {
      addQualityRule(draft);
      return;
    }
    addRecipeStep(draft);
  };

  const previewQualityRule = (rule: QualityRule) => {
    setDraftPreviewQualityRule(null);
    setSelectedQualityRuleId(rule.id);
    ruleAction("etl.rules.quality_rule_previewed", `/api/etl/rules/quality/${rule.id}/preview`);
  };

  const editQualityRule = (rule: QualityRule) => {
    setSelectedRuleCategory("quality");
    setEditingQualityRuleId(rule.id);
    setEditingTransformStepId(null);
    setDraftPreviewStep(null);
    setDraftPreviewQualityRule(null);
    setSelectedQualityRuleId(rule.id);
    ruleAction("etl.rules.quality_rule_edit_started", `/api/etl/rules/quality/${rule.id}`);
  };

  const removeQualityRule = (rule: QualityRule) => {
    const baseRules = getPermanentQualityRules(qualityRules);
    if (baseRules.length <= 1) {
      onNotify("최소 1개 quality rule은 유지해야 합니다.");
      return;
    }
    const removedIndex = baseRules.findIndex((currentRule) => currentRule.id === rule.id);
    const nextRules = baseRules.filter((currentRule) => currentRule.id !== rule.id);
    setQualityRules(nextRules);
    setDraftPreviewQualityRule(null);
    if (editingQualityRuleId === rule.id) {
      setEditingQualityRuleId(null);
    }
    if (!nextRules.some((nextRule) => nextRule.id === selectedQualityRuleId)) {
      const nextSelectedRule = nextRules[Math.min(Math.max(removedIndex, 0), nextRules.length - 1)] ?? nextRules[0];
      setSelectedQualityRuleId(nextSelectedRule.id);
    }
    applyRuleDraft(recipeSteps, nextRules);
    ruleAction("etl.rules.quality_rule_removed", `/api/etl/rules/quality/${rule.id}`);
    onNotify("quality check가 제외되었습니다.");
  };

  const updateQualityRule = (draft: RuleStepDraft) => {
    if (!editingQualityRuleId) return;
    const baseRules = getPermanentQualityRules(qualityRules);
    const currentRule = baseRules.find((rule) => rule.id === editingQualityRuleId);
    if (!currentRule) {
      setEditingQualityRuleId(null);
      onNotify("수정할 quality rule을 찾을 수 없습니다.");
      return;
    }
    const updatedRule = createQualityRuleFromDraft(draft, currentRule.id);
    const nextRules = baseRules.map((rule) => rule.id === currentRule.id ? updatedRule : rule);
    setQualityRules(nextRules);
    setDraftPreviewQualityRule(null);
    setEditingQualityRuleId(null);
    setSelectedQualityRuleId(updatedRule.id);
    applyRuleDraft(recipeSteps, nextRules);
    ruleAction("etl.rules.quality_rule_updated", `/api/etl/rules/quality/${updatedRule.id}`);
    onNotify("quality check가 업데이트되었습니다.");
  };

  const previewDraftStep = (draft: RuleStepDraft) => {
    if (selectedRuleCategory === "quality") {
      const draftRule = createQualityRuleFromDraft(draft, editingQualityRuleId ?? `${QUALITY_DRAFT_PREVIEW_ID_PREFIX}${Date.now()}`);
      setDraftPreviewQualityRule(draftRule);
      setSelectedQualityRuleId(draftRule.id);
      ruleAction("etl.rules.quality_rule_previewed", "/api/etl/rules/quality/preview");
      return;
    }
    const currentStep = editingTransformStepId ? recipeSteps.find((step) => step.id === editingTransformStepId) : undefined;
    const previewStep = createRecipeStepFromDraft(draft, editingTransformStepId ?? `draft-preview-${Date.now()}`, currentStep);
    setDraftPreviewStep(previewStep);
    setDraftPreviewQualityRule(null);
    setSelectedPreviewStepId(previewStep.id);
    ruleAction("etl.rules.step_previewed", "/api/etl/rules/steps/preview");
  };

  const toggleInvalidRows = () => {
    setShowInvalidRows((visible) => !visible);
    ruleAction("etl.rules.invalid_rows_toggled", "/api/etl/rules/invalid-rows");
  };

  return (
    <div className="hegun-rule-page">
      <RuleMetrics stats={ruleStats} />
      <RuleCategoryTabs activeCategory={selectedRuleCategory} onSelect={(category) => {
        setSelectedRuleCategory(category);
        ruleAction("etl.rules.category_selected", `/api/etl/rules/categories/${category}`);
      }} />
      <div className="hegun-rule-workspace">
        <div className="hegun-rule-main-stack">
          {selectedRuleCategory === "quality" ? (
            <QualityRulesTable rules={qualityRules} selectedRuleId={selectedQualityRuleId} onEdit={editQualityRule} onPreview={previewQualityRule} onRemove={removeQualityRule} />
          ) : (
            <RecipeStepsTable selectedStepId={selectedPreviewStep.id} steps={recipeSteps} onEdit={editRecipeStep} onPreview={previewRecipeStep} onRemove={removeRecipeStep} />
          )}
          <RuleStepBuilder
            baseColumnSet={sourceColumnSet}
            category={selectedRuleCategory}
            editingDraft={editingDraft}
            editingLabel={editingLabel}
            qualityPresets={defaultQualityRules}
            transformPresets={defaultRecipeSteps}
            workingColumns={workingColumns}
            onAction={ruleAction}
            onAddStep={addRuleDraft}
            onCancelEdit={cancelRuleEdit}
            onPreviewStep={previewDraftStep}
            onUpdateStep={selectedRuleCategory === "quality" ? updateQualityRule : updateRecipeStep}
          />
          {selectedRuleCategory === "quality" ? (
            <QualityPreviewAnalysis invalidRows={selectedQualityInvalidRows} rule={selectedQualityRule} sampleRows={qualityPreviewRunnerResult.validation.sampleRows} onAction={ruleAction} />
          ) : (
            <StepPreviewAnalysis
              preview={previewRunnerResult.previewByStepId[selectedPreviewStep.id]}
              step={selectedPreviewStep}
              onAction={ruleAction}
            />
          )}
          <FinalDatasetPreviewPanel
            columns={workingColumns}
            derivedColumns={derivedColumns}
            invalidRowCount={invalidRowCount}
            rows={runnerResult.transformedRows}
            totalRows={runnerResult.transformedRows.length}
            transformStepCount={recipeSteps.length}
          />
          {selectedRuleCategory === "quality" && <QualityFailedRowsPanel invalidRows={selectedQualityInvalidRows} rule={selectedQualityRule} onAction={ruleAction} />}
          {showInvalidRows && <InvalidRowsPanel invalidRows={invalidRows} invalidRowsPreviewSummary={invalidRowsPreviewSummary} onAction={ruleAction} />}
        </div>
      </div>
      <RuleBottomBar invalidRowCount={invalidRowCount} invalidRowsVisible={showInvalidRows} onInvalidRows={toggleInvalidRows} onNext={goNext} onPrev={onPrev} onSave={saveRuleDraft} onTest={testRules} />
    </div>
  );
}
