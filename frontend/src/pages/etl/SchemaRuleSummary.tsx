import { AlertTriangle, ShieldCheck, SlidersHorizontal } from "lucide-react";

import { Panel, PanelHeader } from "../../components/ui/panel";
import { summarizeSchemaRuleState } from "../../services/schemaRuleSummary";
import type { QualityRuleDraft, SchemaColumnDraft, TransformStepDraft } from "../../types";

type SchemaRuleSummaryProps = {
  columns: SchemaColumnDraft[];
  qualityRules: QualityRuleDraft[];
  transformSteps: TransformStepDraft[];
};

const QUALITY_RULE_LABELS: Record<QualityRuleDraft["validationType"], string> = {
  "Accepted Values": "허용값",
  "Not Null": "필수",
  "Range Check": "범위",
  "Regex Match": "형식",
};

const FAILURE_ACTION_LABELS: Record<string, string> = {
  "Drop Row": "행 제외",
  "Fail Run": "실행 실패",
  Quarantine: "격리",
  "Set Null": "NULL 대체",
  Warn: "기록 후 계속",
};

export function SchemaRuleSummary({ columns, qualityRules, transformSteps }: SchemaRuleSummaryProps) {
  const {
    enabledQualityRules,
    failureActions,
    qualityRuleCount,
    requiredColumnCount,
    transformedColumnCount,
    transformRules,
  } = summarizeSchemaRuleState(columns, qualityRules, transformSteps);

  return (
    <Panel className="schema-applied-rules mt-4" variant="plain">
      <PanelHeader
        className="min-h-[68px] px-5 py-3.5"
        description="스키마 확정 전에 적용될 변환과 검사 정책을 확인합니다."
        icon={<ShieldCheck />}
        title="적용 규칙 요약"
      />
      <div className="grid grid-cols-1 px-5 py-4 md:grid-cols-3 md:px-6">
        <RuleSummaryItem
          detail={transformRules.length > 0 ? `적용 컬럼 ${transformedColumnCount}개` : "설정된 변환 없음"}
          icon={<SlidersHorizontal />}
          label="변환 규칙"
          value={`${transformRules.length}개 변환`}
        />
        <RuleSummaryItem
          detail={summarizeQualityRules(requiredColumnCount, enabledQualityRules)}
          icon={<ShieldCheck />}
          label="품질 규칙"
          value={`${qualityRuleCount}개 검사`}
        />
        <RuleSummaryItem
          detail={summarizeFailureActions(failureActions)}
          icon={<AlertTriangle />}
          label="실패 처리"
          value={failureActions.length > 0 ? `${failureActions.length}개 정책` : "기본 정책"}
        />
      </div>
    </Panel>
  );
}

function RuleSummaryItem({
  detail,
  icon,
  label,
  value,
}: {
  detail: string;
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <article className="grid min-w-0 gap-1.5 border-b border-slate-200 py-4 last:border-b-0 md:border-b-0 md:border-r md:px-6 md:py-1 md:first:pl-0 md:last:border-r-0 md:last:pr-0">
      <div className="flex min-w-0 items-center gap-2 text-sm font-bold text-slate-500">
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-blue-50 text-blue-600 [&_svg]:size-4">
          {icon}
        </span>
        <span>{label}</span>
      </div>
      <strong className="text-2xl font-extrabold leading-tight tracking-normal text-slate-950">{value}</strong>
      <span className="min-w-0 text-sm font-medium leading-snug text-slate-500 [overflow-wrap:anywhere]">{detail}</span>
    </article>
  );
}

function summarizeQualityRules(requiredColumnCount: number, rules: QualityRuleDraft[]) {
  const counts = new Map<string, number>();
  rules.forEach((rule) => {
    const label = QUALITY_RULE_LABELS[rule.validationType];
    counts.set(label, (counts.get(label) ?? 0) + 1);
  });
  const qualitySummary = counts.size === 0
    ? "품질 검사 없음"
    : Array.from(counts.entries())
    .map(([label, count]) => `${label} ${count}`)
    .join(" · ");
  const schemaSummary = requiredColumnCount > 0 ? `출력 필수 ${requiredColumnCount}개` : "출력 필수 없음";
  return `${qualitySummary} · ${schemaSummary}`;
}

function summarizeFailureActions(actions: string[]) {
  if (actions.length === 0) return "별도 실패 처리 없음";
  const counts = new Map<string, number>();
  actions.forEach((action) => {
    const label = FAILURE_ACTION_LABELS[action] ?? action;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  });
  return Array.from(counts.entries())
    .map(([label, count]) => `${label} ${count}개`)
    .join(" · ");
}
