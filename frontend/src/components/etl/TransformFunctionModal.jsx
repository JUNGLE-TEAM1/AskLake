import React, { useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import InlineAIInput from '../ai/InlineAIInput';
import { ActionGroup } from '../ui/action-group';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { DialogShell } from '../ui/dialog-shell';
import { Field, FieldDescription, FieldLabel, FieldTitle } from '../ui/field';
import { Input } from '../ui/input';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '../ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { Textarea } from '../ui/textarea';

const PORTABLE_OPERATIONS = [
    { label: '추가 변환 없음', operation: '', value: 'none' },
    { label: '소문자 + 공백 정리', operation: 'Lowercase + Trim', value: 'lowercase_trim' },
    { label: 'JSON 경로 추출', operation: 'Extract JSONPath', parameterLabel: 'JSONPath', value: 'json_extract' },
    { label: '마스킹', operation: 'Mask', parameterLabel: '마스킹 정책', value: 'mask' },
    { label: 'Timestamp 파싱', operation: 'Parse Timestamp', parameterLabel: '입력 형식', value: 'parse_timestamp' },
    { label: '값 복사', operation: 'Copy', value: 'copy' },
];

function portableOperationValue(operation = '') {
    const normalized = String(operation).toLowerCase().replace(/[^a-z0-9]+/g, '_');
    if (normalized.includes('lower') || normalized.includes('trim')) return 'lowercase_trim';
    if (normalized.includes('json')) return 'json_extract';
    if (normalized.includes('mask')) return 'mask';
    if (normalized.includes('timestamp')) return 'parse_timestamp';
    if (normalized.includes('copy')) return 'copy';
    return 'none';
}

function portableDefaultParams(operation) {
    if (operation === 'json_extract') return '$.value';
    if (operation === 'mask') return 'phone';
    if (operation === 'parse_timestamp') return 'ISO-8601';
    return '';
}

const QUALITY_RULE_DEFINITIONS = [
    {
        defaultParams: '',
        description: 'NULL 또는 빈 값을 품질 오류로 감지합니다.',
        kind: 'notNull',
        label: 'NULL 값 검사',
        validationType: 'Not Null',
    },
    {
        defaultParams: '0,100000000',
        description: '숫자 값이 지정한 최솟값과 최댓값 사이인지 검사합니다.',
        kind: 'range',
        label: '범위 검사',
        placeholder: '예: 0,100000000',
        validationType: 'Range Check',
    },
    {
        defaultParams: '',
        description: '문자열이 지정한 정규식 패턴과 일치하는지 검사합니다.',
        kind: 'regex',
        label: '정규식 검사',
        placeholder: '예: ^[A-Z]{3}-[0-9]+$',
        validationType: 'Regex Match',
    },
    {
        defaultParams: '',
        description: '허용할 값을 쉼표로 구분해 제한합니다.',
        kind: 'acceptedValues',
        label: '허용값 검사',
        placeholder: '예: paid,pending,canceled',
        validationType: 'Accepted Values',
    },
];

/**
 * TransformFunctionModal - Modal for editing column transform and quality rules.
 */
export default function TransformFunctionModal({ column, qualityRules = [], onApply, onClose, portable = false }) {
    const editorRef = useRef(null);
    const [newName, setNewName] = useState(column.name);
    const [newType, setNewType] = useState(column.type);
    const [transformExpr, setTransformExpr] = useState(column.transform || column.originalName || column.name);
    const [selectedFunction, setSelectedFunction] = useState('');
    const [showAI, setShowAI] = useState(false);
    const [portableOperation, setPortableOperation] = useState(() => portableOperationValue(column.transformOperation));
    const [portableParams, setPortableParams] = useState(column.transformParams || portableDefaultParams(portableOperationValue(column.transformOperation)));
    const [portableOnError, setPortableOnError] = useState(column.onError || 'Warn');
    const [required, setRequired] = useState(Boolean(column.notNull));
    const [transformOnError, setTransformOnError] = useState(column.onError || 'Warn');
    const [ruleDrafts, setRuleDrafts] = useState(() => buildInitialRuleDrafts(column, qualityRules));

    const functions = [
        { name: 'UPPER', desc: 'Convert to uppercase', template: `UPPER(CAST(${column.originalName} AS STRING))` },
        { name: 'LOWER', desc: 'Convert to lowercase', template: `LOWER(CAST(${column.originalName} AS STRING))` },
        { name: 'TRIM', desc: 'Remove whitespace', template: `TRIM(CAST(${column.originalName} AS STRING))` },
        { name: 'REPLACE', desc: 'Replace characters', template: `REPLACE(CAST(${column.originalName} AS STRING), '', '')` },
        { name: 'SUBSTR', desc: 'Extract substring', template: `SUBSTR(CAST(${column.originalName} AS STRING), 1, 10)` },
        { name: 'CONCAT', desc: 'Concatenate strings', template: `CONCAT(CAST(${column.originalName} AS STRING), '-', CAST(${column.originalName} AS STRING))` },
        { name: 'CAST', desc: 'Convert type', template: `CAST(${column.originalName} AS STRING)` },
        { name: 'COALESCE', desc: 'Handle nulls', template: `COALESCE(${column.originalName}, 'default')` },
        { name: 'ROUND', desc: 'Round number', template: `ROUND(CAST(${column.originalName} AS DOUBLE), 2)` },
        { name: 'ABS', desc: 'Absolute value', template: `ABS(CAST(${column.originalName} AS DOUBLE))` },
    ];

    const enabledRuleDrafts = ruleDrafts.filter((rule) => rule.enabled);

    const applyFunction = (func) => {
        const isOriginalField = transformExpr === column.originalName || transformExpr === column.name;

        if (isOriginalField) {
            setTransformExpr(func.template);
            setSelectedFunction(func.name);
            if (editorRef.current) setTimeout(() => editorRef.current.focus(), 0);
            return;
        }

        if (editorRef.current) {
            const textarea = editorRef.current;
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            const text = textarea.value;
            const newText = text.substring(0, start) + func.template + text.substring(end, text.length);
            setTransformExpr(newText);
            setTimeout(() => {
                textarea.focus();
                const nextCursor = start + func.template.length;
                textarea.setSelectionRange(nextCursor, nextCursor);
            }, 0);
        } else {
            setTransformExpr((current) => current + func.template);
        }
        setSelectedFunction(func.name);
    };

    const updateRuleDraft = (kind, patch) => {
        setRuleDrafts((current) => current.map((rule) => (
            rule.kind === kind ? { ...rule, ...patch } : rule
        )));
    };

    const qualityRulePayload = (targetColumn) => ruleDrafts
        .filter((rule) => rule.enabled)
        .map((rule) => ({
            enabled: true,
            failureAction: rule.failureAction,
            id: rule.id || `schema-quality-${rule.kind}-${slugify(targetColumn)}`,
            kind: rule.kind,
            params: rule.params.trim() || undefined,
            severity: rule.severity,
            targetColumn,
            validationType: rule.validationType,
        }));

    const applyFieldRules = () => {
        const targetColumn = newName.trim() || column.name;
        const sourceExpression = column.originalName || column.name;
        const hasExpression = transformExpr.trim() && transformExpr.trim() !== sourceExpression;
        onApply(hasExpression ? transformExpr : '', targetColumn, newType, {
            mode: hasExpression ? undefined : 'clear',
            onError: transformOnError,
            qualityRules: qualityRulePayload(targetColumn),
            required,
        });
    };

    const selectedPortableOperation = PORTABLE_OPERATIONS.find((operation) => operation.value === portableOperation)
        || PORTABLE_OPERATIONS[0];
    const applyPortableFieldRules = () => {
        const targetColumn = newName.trim() || column.name;
        const common = {
            onError: portableOnError,
            qualityRules: qualityRulePayload(targetColumn),
            required,
            type: newType,
        };
        if (!selectedPortableOperation.operation) {
            onApply('', targetColumn, newType, { ...common, mode: 'clear' });
            return;
        }
        const step = {
            display: selectedPortableOperation.label,
            expression: '',
            onError: portableOnError,
            operation: selectedPortableOperation.operation,
            params: portableParams,
            type: newType,
        };
        onApply('', targetColumn, newType, {
            ...common,
            chain: [step],
            display: selectedPortableOperation.label,
            operation: selectedPortableOperation.operation,
            params: portableParams,
        });
    };

    return (
        <DialogShell
            bodyClassName="!p-0"
            closeLabel="닫기"
            contentClassName="rounded-lg"
            footer={(
                <ActionGroup density="compact">
                    <Button type="button" onClick={onClose} size="sm" variant="outline">취소</Button>
                    <Button type="button" onClick={portable ? applyPortableFieldRules : applyFieldRules} size="sm">필드 규칙 적용</Button>
                </ActionGroup>
            )}
            footerClassName="bg-slate-50/50"
            headerClassName="bg-slate-50/50"
            onClose={onClose}
            size="lg"
            title="필드 규칙 설정"
        >
            <Tabs className="p-5" defaultValue="transform">
                <TabsList className="grid w-full grid-cols-3">
                    <TabsTrigger value="transform">변환</TabsTrigger>
                    <TabsTrigger value="quality">품질 검사</TabsTrigger>
                    <TabsTrigger value="failure">실패 처리</TabsTrigger>
                </TabsList>

                <TabsContent className="space-y-5" value="transform">
                    <div className="grid gap-4 sm:grid-cols-2">
                        <Field>
                            <FieldLabel htmlFor="field-rule-output-name">출력 컬럼명</FieldLabel>
                            <Input
                                id="field-rule-output-name"
                                onChange={(event) => setNewName(event.target.value)}
                                value={newName}
                            />
                        </Field>
                        <Field>
                            <FieldLabel htmlFor="field-rule-data-type">데이터 타입</FieldLabel>
                            <Select
                                onValueChange={setNewType}
                                value={newType}
                            >
                                <SelectTrigger aria-label="데이터 타입" id="field-rule-data-type">
                                    <SelectValue placeholder="데이터 타입 선택" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="string">string</SelectItem>
                                    <SelectItem value="integer">integer</SelectItem>
                                    <SelectItem value="long">long</SelectItem>
                                    <SelectItem value="double">double</SelectItem>
                                    <SelectItem value="boolean">boolean</SelectItem>
                                    <SelectItem value="timestamp">timestamp</SelectItem>
                                    <SelectItem value="date">date</SelectItem>
                                    <SelectItem value="json">json</SelectItem>
                                </SelectContent>
                            </Select>
                        </Field>
                    </div>

                    {portable ? (
                        <div className="grid gap-4">
                            <Field>
                                <FieldLabel htmlFor="field-portable-operation">변환 방식</FieldLabel>
                                <Select
                                    onValueChange={(value) => {
                                        setPortableOperation(value);
                                        setPortableParams(portableDefaultParams(value));
                                        if (value === 'parse_timestamp') setNewType('timestamp');
                                    }}
                                    value={portableOperation}
                                >
                                    <SelectTrigger id="field-portable-operation">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {PORTABLE_OPERATIONS.map((operation) => (
                                            <SelectItem key={operation.value} value={operation.value}>{operation.label}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                                <FieldDescription>Kafka Snapshot과 실시간 실행에서 동일하게 지원되는 변환만 표시합니다.</FieldDescription>
                            </Field>
                            {selectedPortableOperation.parameterLabel ? (
                                <Field>
                                    <FieldLabel htmlFor="field-portable-params">{selectedPortableOperation.parameterLabel}</FieldLabel>
                                    <Input
                                        className="font-mono"
                                        id="field-portable-params"
                                        onChange={(event) => setPortableParams(event.target.value)}
                                        value={portableParams}
                                    />
                                </Field>
                            ) : null}
                        </div>
                    ) : (
                        <>
                            <div>
                                <span className="mb-2 block text-sm font-bold text-slate-600">빠른 변환</span>
                                <div className="flex flex-wrap gap-2">
                                    {functions.map((func) => (
                                        <Button
                                            key={func.name}
                                            onClick={() => applyFunction(func)}
                                            size="sm"
                                            title={func.desc}
                                            type="button"
                                            variant={selectedFunction === func.name ? 'default' : 'outline'}
                                        >
                                            {func.name}
                                        </Button>
                                    ))}
                                </div>
                            </div>

                            <Field>
                                <div className="mb-2 flex items-center justify-between gap-3">
                                    <FieldLabel htmlFor="field-transform-expression">변환식 (SQL)</FieldLabel>
                                    <Button type="button" onClick={() => setShowAI(!showAI)} size="sm" variant="outline">
                                        <Sparkles size={14} /> AI
                                    </Button>
                                </div>
                                {showAI && (
                                    <InlineAIInput
                                        promptType="field_transform"
                                        metadata={{ column_name: column.originalName, column_type: column.type }}
                                        placeholder="예: 대문자로 변환, 앞 3글자 추출"
                                        onApply={(suggestion) => {
                                            setTransformExpr(suggestion);
                                            setShowAI(false);
                                            if (editorRef.current) setTimeout(() => editorRef.current.focus(), 0);
                                        }}
                                        onCancel={() => setShowAI(false)}
                                    />
                                )}
                                <Textarea
                                    className="min-h-28 resize-y bg-slate-50/30 font-mono text-sm"
                                    id="field-transform-expression"
                                    ref={editorRef}
                                    value={transformExpr}
                                    onChange={(event) => setTransformExpr(event.target.value)}
                                    rows={4}
                                    placeholder={`예: CAST(${column.originalName} AS STRING)`}
                                />
                                <FieldDescription>출력 타입 변경과 함께 적용할 SQL 표현식을 입력합니다.</FieldDescription>
                            </Field>
                        </>
                    )}
                </TabsContent>

                <TabsContent className="space-y-4" value="quality">
                    <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 transition-colors hover:border-blue-200 hover:bg-blue-50/40">
                        <Checkbox checked={required} onCheckedChange={(checked) => setRequired(checked === true)} />
                        <span className="grid gap-1">
                            <FieldTitle>출력 스키마에서 필수 컬럼</FieldTitle>
                            <FieldDescription>출력 컬럼의 nullable 속성을 false로 저장합니다.</FieldDescription>
                        </span>
                    </label>

                    <div className="grid gap-3">
                        {ruleDrafts.map((rule) => (
                            <div key={rule.kind} className="grid gap-3 rounded-lg border border-slate-200 px-4 py-3">
                                <div className="flex items-start gap-3">
                                    <Checkbox
                                        checked={rule.enabled}
                                        onCheckedChange={(checked) => updateRuleDraft(rule.kind, { enabled: checked === true })}
                                    />
                                    <span className="grid min-w-0 flex-1 gap-1">
                                        <FieldTitle>{rule.label}</FieldTitle>
                                        <FieldDescription>{rule.description}</FieldDescription>
                                    </span>
                                </div>
                                {rule.enabled && rule.validationType !== 'Not Null' ? (
                                    <Input
                                        aria-label={`${rule.label} 설정값`}
                                        onChange={(event) => updateRuleDraft(rule.kind, { params: event.target.value })}
                                        placeholder={rule.placeholder}
                                        value={rule.params}
                                    />
                                ) : null}
                            </div>
                        ))}
                    </div>
                </TabsContent>

                <TabsContent className="space-y-4" value="failure">
                    <FailureRuleRow
                        action={portable ? portableOnError : transformOnError}
                        label="필드 변환 실패"
                        onActionChange={portable ? setPortableOnError : setTransformOnError}
                        onSeverityChange={() => undefined}
                        severity="Error"
                        showSeverity={false}
                    />
                    {enabledRuleDrafts.map((rule) => (
                        <FailureRuleRow
                            key={rule.kind}
                            action={rule.failureAction}
                            label={rule.label}
                            onActionChange={(failureAction) => updateRuleDraft(rule.kind, { failureAction })}
                            onSeverityChange={(severity) => updateRuleDraft(rule.kind, { severity })}
                            severity={rule.severity}
                        />
                    ))}
                    {enabledRuleDrafts.length === 0 ? (
                        <p className="rounded-lg border border-dashed border-slate-300 px-4 py-5 text-center text-sm font-medium text-slate-500">
                            품질 검사 탭에서 규칙을 선택하면 규칙별 실패 처리를 설정할 수 있습니다.
                        </p>
                    ) : null}
                </TabsContent>
            </Tabs>
        </DialogShell>
    );
}

function FailureRuleRow({ action, label, onActionChange, onSeverityChange, severity, showSeverity = true }) {
    return (
        <div className="grid items-center gap-3 rounded-lg border border-slate-200 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_130px_170px]">
            <FieldTitle>{label}</FieldTitle>
            {showSeverity ? (
                <Select
                    onValueChange={onSeverityChange}
                    value={severity}
                >
                    <SelectTrigger aria-label={`${label} 심각도`} size="sm">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="Error">오류</SelectItem>
                        <SelectItem value="Warning">경고</SelectItem>
                    </SelectContent>
                </Select>
            ) : <span />}
            <Select
                onValueChange={onActionChange}
                value={action}
            >
                <SelectTrigger aria-label={`${label} 실패 처리`} size="sm">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value="Warn">기록 후 계속</SelectItem>
                    <SelectItem value="Fail Run">실행 실패</SelectItem>
                    <SelectItem value="Drop Row">행 제외</SelectItem>
                    <SelectItem value="Quarantine">격리</SelectItem>
                    <SelectItem value="Set Null">NULL 대체</SelectItem>
                </SelectContent>
            </Select>
        </div>
    );
}

function buildInitialRuleDrafts(column, qualityRules) {
    const aliases = new Set([column.name, column.originalName].filter(Boolean));
    return QUALITY_RULE_DEFINITIONS.map((definition) => {
        const existing = qualityRules.find((rule) => (
            aliases.has(rule.targetColumn) && rule.validationType === definition.validationType
        ));
        return {
            ...definition,
            enabled: Boolean(existing?.enabled),
            failureAction: existing?.failureAction || 'Warn',
            id: existing?.id || '',
            params: existing?.params || definition.defaultParams,
            severity: existing?.severity || (definition.kind === 'notNull' ? 'Error' : 'Warning'),
        };
    });
}

function slugify(value) {
    return String(value || 'field').trim().replace(/[^a-zA-Z0-9_]+/g, '-').replace(/^-+|-+$/g, '') || 'field';
}
