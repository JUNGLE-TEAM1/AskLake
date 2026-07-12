import React, { useState, useRef } from 'react';
import { Sparkles } from 'lucide-react';
import InlineAIInput from '../ai/InlineAIInput';
import { ActionGroup } from '../ui/action-group';
import { Button } from '../ui/button';
import { DialogShell } from '../ui/dialog-shell';

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

/**
 * TransformFunctionModal - Modal for editing column transform functions
 */
export default function TransformFunctionModal({ column, onApply, onClose, portable = false }) {
    const editorRef = useRef(null);
    const [newName, setNewName] = useState(column.name);
    const [newType, setNewType] = useState(column.type);
    const [transformExpr, setTransformExpr] = useState(column.transform || column.originalName || column.name);
    const [selectedFunction, setSelectedFunction] = useState('');
    const [showAI, setShowAI] = useState(false);
    const [portableOperation, setPortableOperation] = useState(() => portableOperationValue(column.transformOperation));
    const [portableParams, setPortableParams] = useState(column.transformParams || portableDefaultParams(portableOperationValue(column.transformOperation)));
    const [portableOnError, setPortableOnError] = useState(column.onError || 'Warn');

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

    const applyFunction = (func) => {
        // If current expression is just the original field name (not transformed yet),
        // replace it entirely with the function template
        const isOriginalField = transformExpr === column.originalName || transformExpr === column.name;

        if (isOriginalField) {
            // Replace entire expression
            setTransformExpr(func.template);
            setSelectedFunction(func.name);

            // Focus textarea after replacement
            if (editorRef.current) {
                setTimeout(() => {
                    editorRef.current.focus();
                }, 0);
            }
        } else if (editorRef.current) {
            // Insert at cursor position if already transformed
            const textarea = editorRef.current;
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            const text = textarea.value;
            const before = text.substring(0, start);
            const after = text.substring(end, text.length);
            const newText = before + func.template + after;

            setTransformExpr(newText);

            // Re-focus and set cursor position after React update
            setTimeout(() => {
                textarea.focus();
                const newCursorPos = start + func.template.length;
                textarea.setSelectionRange(newCursorPos, newCursorPos);
            }, 0);
            setSelectedFunction(func.name);
        } else {
            // Fallback: append
            setTransformExpr(prev => prev + func.template);
            setSelectedFunction(func.name);
        }
    };

    if (portable) {
        const selected = PORTABLE_OPERATIONS.find((operation) => operation.value === portableOperation) || PORTABLE_OPERATIONS[0];
        const applyPortableTransform = () => {
            if (!selected.operation) {
                onApply('', newName, newType, { mode: 'clear' });
                return;
            }
            const step = {
                display: selected.label,
                expression: '',
                onError: portableOnError,
                operation: selected.operation,
                params: portableParams,
                type: newType,
            };
            onApply('', newName, newType, {
                chain: [step],
                display: selected.label,
                onError: portableOnError,
                operation: selected.operation,
                params: portableParams,
                type: newType,
            });
        };

        return (
            <DialogShell
                bodyClassName="!p-0"
                closeLabel="닫기"
                contentClassName="rounded-2xl"
                description={`대상 컬럼: ${column.name}`}
                footer={(
                    <ActionGroup density="compact">
                        <Button type="button" onClick={onClose} size="sm" variant="outline">취소</Button>
                        <Button type="button" onClick={applyPortableTransform} size="sm">적용</Button>
                    </ActionGroup>
                )}
                footerClassName="bg-slate-50/50"
                headerClassName="bg-slate-50/50"
                onClose={onClose}
                size="sm"
                title="필드 변환"
            >
                <div className="space-y-5 p-6">
                    <label className="block space-y-2 text-sm font-medium text-slate-700">
                        <span>변환 방식</span>
                        <select
                            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
                            value={portableOperation}
                            onChange={(event) => {
                                const value = event.target.value;
                                setPortableOperation(value);
                                setPortableParams(portableDefaultParams(value));
                                if (value === 'parse_timestamp') setNewType('timestamp');
                            }}
                        >
                            {PORTABLE_OPERATIONS.map((operation) => (
                                <option key={operation.value} value={operation.value}>{operation.label}</option>
                            ))}
                        </select>
                    </label>

                    {selected.parameterLabel ? (
                        <label className="block space-y-2 text-sm font-medium text-slate-700">
                            <span>{selected.parameterLabel}</span>
                            <input
                                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono text-sm"
                                value={portableParams}
                                onChange={(event) => setPortableParams(event.target.value)}
                            />
                        </label>
                    ) : null}

                    {selected.operation ? (
                        <label className="block space-y-2 text-sm font-medium text-slate-700">
                            <span>실패 처리</span>
                            <select
                                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
                                value={portableOnError}
                                onChange={(event) => setPortableOnError(event.target.value)}
                            >
                                <option>Warn</option>
                                <option>Quarantine</option>
                                <option>Fail Run</option>
                                <option>Drop Row</option>
                                <option>Set Null</option>
                            </select>
                        </label>
                    ) : null}
                </div>
            </DialogShell>
        );
    }

    return (
        <DialogShell
            bodyClassName="!p-0"
            closeLabel="Close"
            contentClassName="rounded-2xl"
            description={(
                <>
                    Refining: <span className="text-indigo-600 font-bold">{column.originalName}</span>
                </>
            )}
            footer={(
                <ActionGroup density="compact">
                    <Button type="button" onClick={onClose} size="sm" variant="outline">
                        Cancel
                    </Button>
                    <Button type="button" onClick={() => onApply(transformExpr, newName, newType)} size="sm">
                        Apply Transform
                    </Button>
                </ActionGroup>
            )}
            footerClassName="bg-slate-50/50"
            headerClassName="bg-slate-50/50"
            onClose={onClose}
            size="md"
            title={(
                <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-normal text-slate-800">
                    <span className="h-3 w-1 rounded-full bg-indigo-500" />
                    Field Transform
                </span>
            )}
        >
            <div className="max-h-[50vh] space-y-4 overflow-y-auto p-6">
                {/* Quick Functions */}
                <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Quick Functions</label>
                    <div className="flex flex-wrap gap-2">
                        {functions.map(func => (
                            <button
                                key={func.name}
                                onClick={() => applyFunction(func)}
                                className={`px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-tight transition-all border ${selectedFunction === func.name
                                    ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                                    : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-400 hover:text-indigo-600'
                                    }`}
                                title={func.desc}
                            >
                                {func.name}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Expression Editor */}
                <div>
                    <div className="flex items-center justify-between mb-2">
                        <label className="block text-sm font-medium text-gray-700">Transform Expression (SQL)</label>
                        <button
                            onClick={() => setShowAI(!showAI)}
                            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium
                                bg-gradient-to-r from-indigo-50 to-purple-50 text-indigo-600
                                hover:from-indigo-100 hover:to-purple-100 transition-all
                                border border-indigo-200/50"
                            title="AI Assistant"
                        >
                            <Sparkles size={14} />
                            <span>AI</span>
                        </button>
                    </div>

                    {/* AI Input Panel - appears between flex row and textarea */}
                    {showAI && (
                        <InlineAIInput
                            promptType="field_transform"
                            metadata={{
                                column_name: column.originalName,
                                column_type: column.type
                            }}
                            placeholder="e.g., convert to uppercase, extract first 3 characters..."
                            onApply={(suggestion) => {
                                // Apply AI suggestion to the transform expression
                                setTransformExpr(suggestion);
                                setShowAI(false);
                                // Focus textarea after applying
                                if (editorRef.current) {
                                    setTimeout(() => {
                                        editorRef.current.focus();
                                    }, 0);
                                }
                            }}
                            onCancel={() => setShowAI(false)}
                        />
                    )}

                    <textarea
                        ref={editorRef}
                        value={transformExpr}
                        onChange={(e) => setTransformExpr(e.target.value)}
                        rows={3}
                        className="w-full px-3 py-2 border border-slate-200 rounded-xl font-mono text-sm focus:outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-50/50 transition-all bg-slate-50/30"
                        placeholder={`e.g., CONCAT(SUBSTR(${column.originalName}, 1, 3), '-', SUBSTR(${column.originalName}, 4, 4))`}
                    />
                </div>
            </div>
        </DialogShell>
    );
}
