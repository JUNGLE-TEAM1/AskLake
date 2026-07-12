import React, { useState, useRef } from 'react';
import { Braces, Search } from 'lucide-react';
import { ActionGroup } from '../ui/action-group';
import { Button } from '../ui/button';
import { DialogShell } from '../ui/dialog-shell';

/**
 * TransformFunctionModal - Modal for editing column transform functions
 */
export default function TransformFunctionModal({ column, onApply, onClose }) {
    const editorRef = useRef(null);
    const initialDataStep = Array.isArray(column.transformChain)
        ? column.transformChain.find((step) => step && !['Default Value', 'Null Guard'].includes(step.operation))
        : null;
    const [newName, setNewName] = useState(column.name);
    const [newType, setNewType] = useState(column.type);
    const [transformExpr, setTransformExpr] = useState(column.transform || column.originalName || column.name);
    const [operation, setOperation] = useState(initialDataStep?.operation || column.transformOperation || 'SQL Expression');
    const [regexPattern, setRegexPattern] = useState(String(
        initialDataStep?.operation === 'Extract Regex'
            ? initialDataStep.params
            : column.transformOperation === 'Extract Regex'
                ? column.transformParams
                : String(column.originalName || column.name).toLowerCase().includes('page_url')
                    ? '^/products/([^/]+)'
                    : '(.+)',
    ));
    const [selectedFunction, setSelectedFunction] = useState('');

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
        setOperation('SQL Expression');
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

    const applyCurrentTransform = () => {
        if (operation === 'Extract Regex') {
            onApply('', newName, newType, {
                display: `정규식 추출: ${regexPattern}`,
                expression: '',
                onError: column.onError || 'Warn',
                operation: 'Extract Regex',
                params: regexPattern,
                type: newType,
            });
            return;
        }
        onApply(transformExpr, newName, newType, {
            display: transformExpr,
            expression: transformExpr,
            onError: column.onError || 'Warn',
            operation: 'SQL Expression',
            params: transformExpr,
            type: newType,
        });
    };

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
                    <Button type="button" onClick={applyCurrentTransform} size="sm" disabled={operation === 'Extract Regex' && !regexPattern.trim()}>
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
                <div className="grid grid-cols-2 gap-2 rounded-lg bg-slate-100 p-1" role="tablist" aria-label="변환 방식">
                    <button
                        type="button"
                        role="tab"
                        aria-selected={operation === 'SQL Expression'}
                        onClick={() => setOperation('SQL Expression')}
                        className={`inline-flex min-h-9 items-center justify-center gap-2 rounded-md px-3 text-xs font-bold transition-colors ${operation === 'SQL Expression' ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
                    >
                        <Braces size={15} /> SQL 식
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={operation === 'Extract Regex'}
                        onClick={() => setOperation('Extract Regex')}
                        className={`inline-flex min-h-9 items-center justify-center gap-2 rounded-md px-3 text-xs font-bold transition-colors ${operation === 'Extract Regex' ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
                    >
                        <Search size={15} /> 정규식 추출
                    </button>
                </div>

                {/* Quick Functions */}
                {operation === 'SQL Expression' && <div>
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
                </div>}

                {/* Expression Editor */}
                {operation === 'SQL Expression' ? <div>
                    <div className="mb-2">
                        <label className="block text-sm font-medium text-gray-700">Transform Expression (SQL)</label>
                    </div>

                    <textarea
                        ref={editorRef}
                        value={transformExpr}
                        onChange={(e) => setTransformExpr(e.target.value)}
                        rows={3}
                        className="w-full px-3 py-2 border border-slate-200 rounded-xl font-mono text-sm focus:outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-50/50 transition-all bg-slate-50/30"
                        placeholder={`e.g., CONCAT(SUBSTR(${column.originalName}, 1, 3), '-', SUBSTR(${column.originalName}, 4, 4))`}
                    />
                </div> : <div>
                    <label className="mb-2 block text-sm font-medium text-gray-700" htmlFor="schema-transform-regex">정규식 패턴</label>
                    <input
                        id="schema-transform-regex"
                        type="text"
                        value={regexPattern}
                        onChange={(event) => setRegexPattern(event.target.value)}
                        className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono text-sm transition-all focus:border-indigo-500 focus:outline-none focus:ring-4 focus:ring-indigo-50/50"
                    />
                    <p className="mt-2 text-xs font-medium text-slate-500">첫 번째 캡처 그룹을 새 컬럼 값으로 저장합니다.</p>
                </div>}
            </div>
        </DialogShell>
    );
}
