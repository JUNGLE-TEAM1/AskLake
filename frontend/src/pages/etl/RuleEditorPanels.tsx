import { ActionGroup } from "@/components/ui/action-group";
import { Button } from "@/components/ui/button";
import { FormFieldGroup, NativeSelectField } from "@/components/ui/form-field-group";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import {
  BookOpen,
  ChevronDown,
  ChevronUp,
  Minus,
  Pencil,
  Plus
} from "lucide-react";
import { useEffect, useState } from "react";

import {
  failureActionLabel,
  FALLBACK_QUALITY_RULES,
  FALLBACK_RECIPE_STEPS,
  getAllowedTransformOperation,
  getDefaultParamForOperation,
  getQualityFailureAction,
  getQualitySeverity,
  getQualityValidationType,
  getRecommendedOutputColumn,
  getTransformFailurePolicy,
  QUALITY_FAILURE_ACTION_OPTIONS,
  QUALITY_SEVERITY_OPTIONS,
  QUALITY_VALIDATION_OPTIONS,
  QualityRule,
  qualitySeverityLabel,
  qualityValidationLabel,
  RecipeStep,
  RULE_CATEGORIES,
  RULE_METRIC_DEFS,
  RuleActionHandler,
  RuleCategory,
  RuleStats,
  RuleStepDraft,
  TRANSFORM_FAILURE_POLICY_OPTIONS,
  TRANSFORM_OPERATION_OPTIONS,
  TransformFailurePolicy,
  TransformOperation,
  transformOperationLabel
} from "./ruleModel";

export function RuleMetrics({ stats }: { stats: RuleStats; }) {
  return (
    <div className="hegun-rule-metrics">
      {RULE_METRIC_DEFS.map(({ icon, label, value }) => (
        <article className="hegun-rule-metric" key={label}>
          <span className="hegun-rule-metric-icon">{icon}</span>
          <div>
            <span>{label}</span>
            <strong>{value(stats)}</strong>
          </div>
        </article>
      ))}
      <div className="hegun-draft-chip">
        <i />
        초안 변경 있음
      </div>
    </div>
  );
}

export function RuleCategoryTabs({ activeCategory, onSelect }: { activeCategory: RuleCategory; onSelect: (category: RuleCategory) => void; }) {
  return (
    <section className="hegun-rule-mode-switcher" aria-label="처리 규칙 모드">
      <SegmentedTabs
        ariaLabel="처리 규칙 모드"
        buttonClassName="hegun-rule-category"
        className="hegun-rule-category-list"
        items={RULE_CATEGORIES.map((category) => ({
          icon: <span className="hegun-rule-category-icon">{category.icon}</span>,
          label: (
            <>
              <strong>{category.label}</strong>
              <em>{category.description}</em>
            </>
          ),
          value: category.id,
        }))}
        value={activeCategory}
        onValueChange={onSelect}
      />
      <div className="hegun-rail-note">
        <BookOpen size={16} />
        <span>샘플로 먼저 확인하고 실행 시 전체 데이터에 적용합니다.</span>
      </div>
    </section>
  );
}

export function RecipeStepsTable({
  onEdit,
  onPreview,
  onRemove,
  selectedStepId,
  steps,
}: {
  onEdit: (step: RecipeStep) => void;
  onPreview: (step: RecipeStep) => void;
  onRemove: (step: RecipeStep) => void;
  selectedStepId: string;
  steps: RecipeStep[];
}) {
  return (
    <section className="panel hegun-console-panel hegun-recipe-panel">
      <div className="hegun-section-title">
        <h2>변환 규칙 단계</h2>
        <p>규칙은 샘플 데이터에 먼저 순서대로 적용되고, 실행 시 전체 데이터에 적용됩니다.</p>
      </div>
      <div className="hegun-table-scroll">
        <table className="schema-table hegun-recipe-table">
          <thead>
            <tr>
              <th>단계</th>
              <th>입력</th>
              <th>작업</th>
              <th>출력</th>
              <th>옵션</th>
              <th>오류 처리</th>
              <th>작업</th>
            </tr>
          </thead>
          <tbody>
            {steps.map((row, index) => {
              const stepNumber = index + 1;
              const isSelected = row.id === selectedStepId;
              return (
                <tr
                  aria-current={isSelected ? "step" : undefined}
                  className={isSelected ? "selected" : undefined}
                  key={`${row.id}-${row.input}`}
                  onClick={() => onPreview(row)}
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onPreview(row);
                    }
                  }}
                >
                  <td>
                    <span className="hegun-step-number"><strong>{stepNumber}</strong></span>
                  </td>
                  <td><span className="hegun-data-chip">{row.input}</span></td>
                  <td>{transformOperationLabel(row.operation)}</td>
                  <td><span className="hegun-data-chip muted">{row.output}</span></td>
                  <td>{row.params}</td>
                  <td><span className={`hegun-error-pill ${row.onError.toLowerCase().replace(/\s/g, "-")}`}>{failureActionLabel(row.onError)}</span></td>
                  <td>
                    <div className="hegun-row-actions">
                      <button aria-label={`${stepNumber}번 단계 수정`} type="button" onClick={(event) => {
                        event.stopPropagation();
                        onEdit(row);
                      }}>
                        <Pencil size={15} />
                      </button>
                      <button aria-label={`${stepNumber}번 단계 제거`} type="button" onClick={(event) => {
                        event.stopPropagation();
                        onRemove(row);
                      }}>
                        <Minus size={15} />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function QualityRulesTable({
  onEdit,
  onRemove,
  onPreview,
  rules,
  selectedRuleId,
}: {
  onEdit: (rule: QualityRule) => void;
  onRemove: (rule: QualityRule) => void;
  onPreview: (rule: QualityRule) => void;
  rules: QualityRule[];
  selectedRuleId: string;
}) {
  return (
    <section className="panel hegun-console-panel hegun-recipe-panel">
      <div className="hegun-section-title">
        <h2>품질 검증 규칙</h2>
        <p>검증 규칙은 샘플 행에 먼저 적용하고 실행 전 차단, 격리, 경고 여부를 결정합니다.</p>
      </div>
      <div className="hegun-table-scroll">
        <table className="schema-table hegun-recipe-table hegun-quality-table">
          <thead>
            <tr>
              <th>규칙</th>
              <th>컬럼</th>
              <th>검증</th>
              <th>심각도</th>
              <th>실패 처리</th>
              <th>상태</th>
              <th>작업</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((rule, index) => {
              const isSelected = rule.id === selectedRuleId;
              return (
                <tr
                  aria-current={isSelected ? "step" : undefined}
                  className={isSelected ? "selected" : undefined}
                  key={rule.id}
                  onClick={() => onPreview(rule)}
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onPreview(rule);
                    }
                  }}
                >
                  <td><strong>{index + 1}</strong></td>
                  <td><span className="hegun-data-chip">{rule.targetColumn}</span></td>
                  <td>{qualityValidationLabel(rule.validationType)}</td>
                  <td><span className={`hegun-error-pill ${rule.severity.toLowerCase()}`}>{qualitySeverityLabel(rule.severity)}</span></td>
                  <td><span className={`hegun-error-pill ${rule.failureAction.toLowerCase().replace(/\s/g, "-")}`}>{failureActionLabel(rule.failureAction)}</span></td>
                  <td>{rule.severity === "Error" ? "차단" : "모니터링"}</td>
                  <td>
                    <div className="hegun-row-actions">
                      <button aria-label={`${index + 1}번 품질 규칙 수정`} type="button" onClick={(event) => {
                        event.stopPropagation();
                        onEdit(rule);
                      }}>
                        <Pencil size={15} />
                      </button>
                      <button aria-label={`${index + 1}번 품질 규칙 제외`} type="button" onClick={(event) => {
                        event.stopPropagation();
                        onRemove(rule);
                      }}>
                        <Minus size={15} />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function RuleStepBuilder({
  baseColumnSet,
  category,
  editingDraft,
  editingLabel,
  onAddStep,
  onAction,
  onCancelEdit,
  onPreviewStep,
  onUpdateStep,
  qualityPresets,
  transformPresets,
  workingColumns,
}: {
  baseColumnSet: Set<string>;
  category: RuleCategory;
  editingDraft: RuleStepDraft | null;
  editingLabel?: string;
  onAddStep: (draft: RuleStepDraft) => void;
  onAction: RuleActionHandler;
  onCancelEdit: () => void;
  onPreviewStep: (draft: RuleStepDraft) => void;
  onUpdateStep: (draft: RuleStepDraft) => void;
  qualityPresets: QualityRule[];
  transformPresets: RecipeStep[];
  workingColumns: string[];
}) {
  const isTransform = category === "transform";
  const isEditing = Boolean(editingDraft);
  const [collapsed, setCollapsed] = useState(true);
  const defaultPresetId = isTransform ? transformPresets[0]?.id ?? "" : qualityPresets[0]?.id ?? "";
  const [selectedPresetId, setSelectedPresetId] = useState(defaultPresetId);
  const selectedTransformPreset = transformPresets.find((step) => step.id === selectedPresetId) ?? transformPresets[0] ?? FALLBACK_RECIPE_STEPS[0];
  const selectedQualityPreset = qualityPresets.find((rule) => rule.id === selectedPresetId) ?? qualityPresets[0] ?? FALLBACK_QUALITY_RULES[0];
  const [selectedInputColumn, setSelectedInputColumn] = useState(selectedTransformPreset.input);
  const [selectedOperation, setSelectedOperation] = useState<TransformOperation>(getAllowedTransformOperation(selectedTransformPreset.operation));
  const [outputColumn, setOutputColumn] = useState(selectedTransformPreset.output);
  const [outputColumnTouched, setOutputColumnTouched] = useState(false);
  const [jsonPath, setJsonPath] = useState(getDefaultParamForOperation("Extract JSONPath"));
  const [decimalFormat, setDecimalFormat] = useState(getDefaultParamForOperation("Cast Decimal"));
  const [timestampFormat, setTimestampFormat] = useState(getDefaultParamForOperation("Parse Timestamp"));
  const [maskPolicy, setMaskPolicy] = useState(getDefaultParamForOperation("Mask"));
  const [onError, setOnError] = useState<TransformFailurePolicy>("Set Null");
  const [selectedTargetColumn, setSelectedTargetColumn] = useState(selectedQualityPreset.targetColumn);
  const [selectedValidationType, setSelectedValidationType] = useState<QualityRule["validationType"]>(selectedQualityPreset.validationType);
  const [selectedSeverity, setSelectedSeverity] = useState<QualityRule["severity"]>(selectedQualityPreset.severity);
  const [selectedFailureAction, setSelectedFailureAction] = useState<QualityRule["failureAction"]>(selectedQualityPreset.failureAction);
  const trimmedOutputColumn = outputColumn.trim();
  const outputColumnMode = trimmedOutputColumn && baseColumnSet.has(trimmedOutputColumn) ? "inPlace" : "derived";
  const getTransformParams = (operation: TransformOperation) => {
    switch (operation) {
      case "Extract JSONPath":
        return jsonPath.trim() || getDefaultParamForOperation(operation);
      case "Lowercase + Trim":
        return getDefaultParamForOperation(operation);
      case "Cast Decimal":
        return decimalFormat.trim() || getDefaultParamForOperation(operation);
      case "Parse Timestamp":
        return timestampFormat.trim() || getDefaultParamForOperation(operation);
      case "Mask":
        return maskPolicy.trim() || getDefaultParamForOperation(operation);
      default:
        return "";
    }
  };
  const selectedDraft = isTransform
    ? {
      input: selectedInputColumn,
      onError,
      operation: selectedOperation,
      output: outputColumn,
      params: getTransformParams(selectedOperation),
    }
    : {
      input: selectedTargetColumn,
      onError: selectedFailureAction,
      operation: selectedValidationType,
      output: "validation_status",
      params: selectedSeverity,
    };
  const presetOptions = isTransform
    ? transformPresets.map((step) => ({ id: step.id, label: `${transformOperationLabel(step.operation)}: ${step.input} -> ${step.output}` }))
    : qualityPresets.map((rule) => ({ id: rule.id, label: `${qualityValidationLabel(rule.validationType)}: ${rule.targetColumn} · ${qualitySeverityLabel(rule.severity)} / ${failureActionLabel(rule.failureAction)}` }));
  const applyTransformPreset = (preset: typeof selectedTransformPreset) => {
    const operation = getAllowedTransformOperation(preset.operation);
    setSelectedInputColumn(preset.input);
    setSelectedOperation(operation);
    setOutputColumn(preset.output || getRecommendedOutputColumn(operation, preset.input));
    setOutputColumnTouched(false);
    setJsonPath(operation === "Extract JSONPath" ? preset.params : getDefaultParamForOperation("Extract JSONPath"));
    setDecimalFormat(operation === "Cast Decimal" ? preset.params : getDefaultParamForOperation("Cast Decimal"));
    setTimestampFormat(operation === "Parse Timestamp" ? preset.params : getDefaultParamForOperation("Parse Timestamp"));
    setMaskPolicy(operation === "Mask" ? preset.params : getDefaultParamForOperation("Mask"));
    setOnError(TRANSFORM_FAILURE_POLICY_OPTIONS.find((option) => option === preset.onError) ?? "Warn");
  };
  const applyQualityPreset = (preset: QualityRule) => {
    setSelectedTargetColumn(preset.targetColumn);
    setSelectedValidationType(preset.validationType);
    setSelectedSeverity(preset.severity);
    setSelectedFailureAction(preset.failureAction);
  };
  const applyTransformDraft = (draft: RuleStepDraft) => {
    const operation = getAllowedTransformOperation(draft.operation);
    setSelectedInputColumn(draft.input);
    setSelectedOperation(operation);
    setOutputColumn(draft.output || getRecommendedOutputColumn(operation, draft.input));
    setOutputColumnTouched(true);
    setJsonPath(operation === "Extract JSONPath" ? draft.params : getDefaultParamForOperation("Extract JSONPath"));
    setDecimalFormat(operation === "Cast Decimal" ? draft.params : getDefaultParamForOperation("Cast Decimal"));
    setTimestampFormat(operation === "Parse Timestamp" ? draft.params : getDefaultParamForOperation("Parse Timestamp"));
    setMaskPolicy(operation === "Mask" ? draft.params : getDefaultParamForOperation("Mask"));
    setOnError(getTransformFailurePolicy(draft.onError));
  };
  const applyQualityDraft = (draft: RuleStepDraft) => {
    setSelectedTargetColumn(draft.input);
    setSelectedValidationType(getQualityValidationType(draft.operation));
    setSelectedSeverity(getQualitySeverity(draft.params));
    setSelectedFailureAction(getQualityFailureAction(draft.onError));
  };
  useEffect(() => {
    if (isEditing) return;
    setSelectedPresetId(defaultPresetId);
  }, [defaultPresetId, isEditing]);
  useEffect(() => {
    if (isEditing) return;
    if (isTransform) {
      applyTransformPreset(selectedTransformPreset);
      return;
    }
    applyQualityPreset(selectedQualityPreset);
  }, [isEditing, isTransform, selectedPresetId, selectedQualityPreset, selectedTransformPreset]);
  useEffect(() => {
    if (!editingDraft) return;
    setCollapsed(false);
    if (isTransform) {
      applyTransformDraft(editingDraft);
      return;
    }
    applyQualityDraft(editingDraft);
  }, [editingDraft, isTransform]);
  useEffect(() => {
    if (!isTransform || outputColumnTouched) return;
    setOutputColumn(getRecommendedOutputColumn(selectedOperation, selectedInputColumn));
  }, [isTransform, outputColumnTouched, selectedInputColumn, selectedOperation]);
  useEffect(() => {
    if (workingColumns.length === 0) return;
    if (isTransform && !workingColumns.includes(selectedInputColumn)) {
      setSelectedInputColumn(workingColumns[0]);
      if (!outputColumnTouched) {
        setOutputColumn(getRecommendedOutputColumn(selectedOperation, workingColumns[0]));
      }
    }
    if (!isTransform && !workingColumns.includes(selectedTargetColumn)) {
      setSelectedTargetColumn(workingColumns[0]);
    }
  }, [isTransform, outputColumnTouched, selectedInputColumn, selectedOperation, selectedTargetColumn, workingColumns]);
  const toggleCollapsed = () => {
    setCollapsed((isCollapsed) => !isCollapsed);
    onAction(collapsed ? "etl.rules.builder_expanded" : "etl.rules.builder_collapsed", "/api/etl/rules/builder");
  };
  const selectTransformOperation = (operation: TransformOperation) => {
    setSelectedOperation(operation);
    if (!outputColumnTouched) {
      setOutputColumn(getRecommendedOutputColumn(operation, selectedInputColumn));
    }
  };
  const selectTransformInputColumn = (inputColumn: string) => {
    setSelectedInputColumn(inputColumn);
    if (!outputColumnTouched) {
      setOutputColumn(getRecommendedOutputColumn(selectedOperation, inputColumn));
    }
  };
  const previewDraft = () => {
    onPreviewStep(selectedDraft);
  };
  const addDraftStep = () => {
    if (isEditing) {
      onUpdateStep(selectedDraft);
    } else {
      onAddStep(selectedDraft);
    }
    setCollapsed(true);
  };
  const cancelEdit = () => {
    onCancelEdit();
    setCollapsed(true);
  };
  const builderTitle = isEditing
    ? isTransform
      ? "변환 단계 수정"
      : "품질 체크 수정"
    : isTransform
      ? "변환 단계 추가"
      : "품질 체크 추가";
  const builderDescription = isEditing
    ? `${editingLabel ?? "선택한 규칙"} 값을 수정한 뒤 같은 규칙에 저장합니다.`
    : isTransform
      ? "현재 스키마 컬럼을 기준으로 새 변환 규칙을 만듭니다."
      : "실행 전에 적용할 품질 검증 규칙을 만듭니다.";
  const submitLabel = isEditing
    ? isTransform ? "단계 수정" : "검사 수정"
    : isTransform ? "선택 단계 추가" : "선택 검사 추가";

  return (
    <section className={collapsed ? "panel hegun-console-panel hegun-builder-panel collapsed" : "panel hegun-console-panel hegun-builder-panel"}>
      <div
        className="hegun-builder-header"
        onClick={toggleCollapsed}
      >
        <div>
          <span className="hegun-builder-icon">{isEditing ? <Pencil size={20} /> : <Plus size={20} />}</span>
          <div>
            <h2>{builderTitle}</h2>
            <p>{builderDescription}</p>
          </div>
        </div>
        <button className="icon-button hegun-builder-collapse" aria-expanded={!collapsed} aria-label={collapsed ? "추가 영역 열기" : "추가 영역 접기"} type="button" onClick={(event) => {
          event.stopPropagation();
          toggleCollapsed();
        }}>
          {collapsed ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
        </button>
      </div>
      {!collapsed && (
        <>
          <div className="hegun-rule-builder">
            {!isEditing && (
              <NativeSelectField
                className="input control-input"
                fieldClassName="hegun-rule-field wide"
                label={isTransform ? "추천 변환 규칙 불러오기" : "추천 품질 규칙 불러오기"}
                value={selectedPresetId}
                onChange={(event) => setSelectedPresetId(event.target.value)}
              >
                {presetOptions.map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </NativeSelectField>
            )}
            <NativeSelectField
              className="input control-input"
              fieldClassName="hegun-rule-field"
              label={isTransform ? "입력 컬럼" : "대상 컬럼"}
              value={isTransform ? selectedInputColumn : selectedTargetColumn}
              onChange={(event) => {
                if (isTransform) {
                  selectTransformInputColumn(event.target.value);
                  return;
                }
                setSelectedTargetColumn(event.target.value);
              }}
            >
              {workingColumns.map((column) => (
                <option key={column} value={column}>
                  {baseColumnSet.has(column) ? column : `${column} (파생)`}
                </option>
              ))}
            </NativeSelectField>
            <FormFieldGroup className="hegun-rule-field" label={isTransform ? "처리 작업" : "검증 규칙"}>
              {isTransform ? (
                <NativeSelect
                  className="input control-input"
                  value={selectedOperation}
                  onChange={(event) => selectTransformOperation(event.target.value as TransformOperation)}
                >
                  {TRANSFORM_OPERATION_OPTIONS.map((operation) => (
                    <option key={operation} value={operation}>{transformOperationLabel(operation)}</option>
                  ))}
                </NativeSelect>
              ) : (
                <NativeSelect
                  className="input control-input"
                  value={selectedValidationType}
                  onChange={(event) => setSelectedValidationType(event.target.value as QualityRule["validationType"])}
                >
                  {QUALITY_VALIDATION_OPTIONS.map((validationType) => (
                    <option key={validationType} value={validationType}>{qualityValidationLabel(validationType)}</option>
                  ))}
                </NativeSelect>
              )}
            </FormFieldGroup>
            <FormFieldGroup className="hegun-rule-field" label={isTransform ? "출력 컬럼" : "심각도"}>
              {isTransform ? (
                <div className="hegun-rule-control-stack">
                  <Input
                    className="input control-input"
                    type="text"
                    value={outputColumn}
                    onChange={(event) => {
                      setOutputColumn(event.target.value);
                      setOutputColumnTouched(true);
                    }}
                  />
                  <em>
                    {trimmedOutputColumn
                      ? outputColumnMode === "inPlace"
                        ? "기존 컬럼을 덮어씁니다."
                        : "새 파생 컬럼을 생성하고 이후 단계에서 사용할 수 있습니다."
                      : "새 이름을 입력하면 이후 단계에서 사용할 수 있는 파생 컬럼이 됩니다."}
                  </em>
                </div>
              ) : (
                <NativeSelect
                  className="input control-input"
                  value={selectedSeverity}
                  onChange={(event) => setSelectedSeverity(event.target.value as QualityRule["severity"])}
                >
                  {QUALITY_SEVERITY_OPTIONS.map((severity) => (
                    <option key={severity} value={severity}>{qualitySeverityLabel(severity)}</option>
                  ))}
                </NativeSelect>
              )}
            </FormFieldGroup>
            <FormFieldGroup className="hegun-rule-field" label={isTransform ? "옵션" : "실패 처리"}>
              {isTransform ? (
                <TransformParameterControl
                  decimalFormat={decimalFormat}
                  jsonPath={jsonPath}
                  maskPolicy={maskPolicy}
                  operation={selectedOperation}
                  timestampFormat={timestampFormat}
                  onDecimalFormatChange={setDecimalFormat}
                  onJsonPathChange={setJsonPath}
                  onMaskPolicyChange={setMaskPolicy}
                  onTimestampFormatChange={setTimestampFormat}
                />
              ) : (
                <NativeSelect
                  className="input control-input"
                  value={selectedFailureAction}
                  onChange={(event) => setSelectedFailureAction(event.target.value as QualityRule["failureAction"])}
                >
                  {QUALITY_FAILURE_ACTION_OPTIONS.map((failureAction) => (
                    <option key={failureAction} value={failureAction}>{failureActionLabel(failureAction)}</option>
                  ))}
                </NativeSelect>
              )}
            </FormFieldGroup>
            {isTransform && (
              <NativeSelectField
                className="input control-input"
                fieldClassName="hegun-rule-field"
                label="오류 처리"
                value={onError}
                onChange={(event) => setOnError(event.target.value as TransformFailurePolicy)}
              >
                {TRANSFORM_FAILURE_POLICY_OPTIONS.map((policy) => (
                  <option key={policy} value={policy}>{failureActionLabel(policy)}</option>
                ))}
              </NativeSelectField>
            )}
          </div>
          <ActionGroup className="hegun-rule-form-actions" density="compact">
            {isEditing && <Button className="ghost-button" type="button" variant="ghost" onClick={cancelEdit}>수정 취소</Button>}
            <Button className="secondary-button" type="button" variant="outline" onClick={previewDraft}>{isTransform ? "선택 단계 미리보기" : "선택 검사 미리보기"}</Button>
            <Button className="primary-button" type="button" onClick={addDraftStep}>{submitLabel}</Button>
          </ActionGroup>
        </>
      )}
    </section>
  );
}

export function TransformParameterControl({
  decimalFormat,
  jsonPath,
  maskPolicy,
  onDecimalFormatChange,
  onJsonPathChange,
  onMaskPolicyChange,
  onTimestampFormatChange,
  operation,
  timestampFormat,
}: {
  decimalFormat: string;
  jsonPath: string;
  maskPolicy: string;
  onDecimalFormatChange: (value: string) => void;
  onJsonPathChange: (value: string) => void;
  onMaskPolicyChange: (value: string) => void;
  onTimestampFormatChange: (value: string) => void;
  operation: TransformOperation;
  timestampFormat: string;
}) {
  if (operation === "Lowercase + Trim") {
    return (
      <div className="hegun-rule-select">
        <strong>추가 파라미터 없음</strong>
        <em>lower(), trim() 규칙으로 저장됩니다.</em>
      </div>
    );
  }

  if (operation === "Extract JSONPath") {
    return (
      <div className="hegun-rule-control-stack">
        <Input className="input control-input" type="text" value={jsonPath} onChange={(event) => onJsonPathChange(event.target.value)} />
        <em>JSON 컬럼에서 꺼낼 경로</em>
      </div>
    );
  }

  if (operation === "Cast Decimal") {
    return (
      <div className="hegun-rule-control-stack">
        <Input className="input control-input" type="text" value={decimalFormat} onChange={(event) => onDecimalFormatChange(event.target.value)} />
        <em>숫자 변환 형식</em>
      </div>
    );
  }

  if (operation === "Parse Timestamp") {
    return (
      <div className="hegun-rule-control-stack">
        <NativeSelect className="input control-input" value={timestampFormat} onChange={(event) => onTimestampFormatChange(event.target.value)}>
          <option value="UTC">UTC</option>
          <option value="string to UTC">string to UTC</option>
        </NativeSelect>
        <em>목표 시간대 / 변환 형식</em>
      </div>
    );
  }

  return (
    <div className="hegun-rule-control-stack">
      <NativeSelect className="input control-input" value={maskPolicy} onChange={(event) => onMaskPolicyChange(event.target.value)}>
        <option value="keep first 3 digits">앞 3자리 유지</option>
        <option value="keep last 4 digits">뒤 4자리 유지</option>
      </NativeSelect>
      <em>마스킹 정책</em>
    </div>
  );
}
