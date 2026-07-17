import { useState } from "react";
import { AlertTriangle, ChevronRight, ShieldCheck, SlidersHorizontal } from "lucide-react";

import { EtlSectionHeader } from "../../components/etl/EtlSectionHeader";
import { Panel } from "../../components/ui/panel";
import {
  summarizeSchemaRuleState,
  type FailurePolicyApplication,
} from "../../services/schemaRuleSummary";
import type { QualityRuleDraft, SchemaColumnDraft, TransformStepDraft } from "../../types";

type SchemaRuleSummaryProps = {
  columns: SchemaColumnDraft[];
  qualityRules: QualityRuleDraft[];
  transformSteps: TransformStepDraft[];
};

type RuleCategory = "failure" | "quality" | "transform";

type RuleDetail = {
  field: string;
  note: string;
  tone?: "continue" | "stop";
  value: string;
};

const QUALITY_RULE_LABELS: Record<QualityRuleDraft["validationType"], string> = {
  "Accepted Values": "허용값 검사",
  "Not Null": "필수값 검사",
  "Range Check": "범위 검사",
  "Regex Match": "형식 검사",
};

const FAILURE_ACTION_LABELS: Record<string, string> = {
  "Drop Row": "행 제외",
  "Fail Run": "실행 중단",
  Quarantine: "별도 격리",
  "Set Null": "NULL로 대체",
  Warn: "기록 후 계속",
};

const FAILURE_ACTION_DESCRIPTIONS: Record<string, string> = {
  "Drop Row": "문제가 있는 행을 결과에서 제외합니다.",
  "Fail Run": "작업을 즉시 중단하고 실패로 기록합니다.",
  Quarantine: "문제가 있는 데이터를 별도 영역으로 보냅니다.",
  "Set Null": "문제가 있는 값을 NULL로 바꿉니다.",
  Warn: "오류를 실행 기록에 남기고 다음 데이터를 처리합니다.",
};

export function SchemaRuleSummary({ columns, qualityRules, transformSteps }: SchemaRuleSummaryProps) {
  const [activeCategory, setActiveCategory] = useState<RuleCategory>("transform");
  const summary = summarizeSchemaRuleState(columns, qualityRules, transformSteps);
  const transformDetails = summary.transformRules.map(transformDetail);
  const qualityDetails = summary.enabledQualityRules.map(qualityDetail);
  const failureDetails = failurePolicyDetails(summary.failurePolicyApplications);

  const tabs: Array<{
    category: RuleCategory;
    icon: React.ReactNode;
    label: string;
    value: string;
  }> = [
    {
      category: "transform",
      icon: <SlidersHorizontal />,
      label: "변환 규칙",
      value: summary.transformRules.length > 0 ? `${summary.transformRules.length}개` : "없음",
    },
    {
      category: "quality",
      icon: <ShieldCheck />,
      label: "품질 규칙",
      value: summary.qualityRuleCount > 0 ? `${summary.qualityRuleCount}개` : "없음",
    },
    {
      category: "failure",
      icon: <AlertTriangle />,
      label: "실패 처리",
      value: summary.failurePolicyCount > 0 ? `${summary.failurePolicyCount}가지` : "기본 처리",
    },
  ];

  const activeDetails = activeCategory === "transform"
    ? transformDetails
    : activeCategory === "quality"
      ? qualityDetails
      : failureDetails;
  const activeTab = tabs.find((tab) => tab.category === activeCategory) ?? tabs[0];

  return (
    <Panel className="schema-applied-rules mt-4 border-blue-200" variant="plain">
      <EtlSectionHeader
        icon={<ShieldCheck />}
        title="적용 내용 확인"
      />

      <div className="grid grid-cols-1 border-b border-slate-200 md:grid-cols-3" role="tablist" aria-label="규칙 유형">
        {tabs.map((tab) => {
          const selected = tab.category === activeCategory;
          return (
            <button
              aria-controls={`schema-rule-${tab.category}-panel`}
              aria-selected={selected}
              className={`relative grid min-h-[96px] min-w-0 grid-cols-[40px_minmax(0,1fr)_20px] items-center gap-3 border-b border-slate-200 px-5 py-4 text-left transition-colors last:border-b-0 hover:bg-blue-50/50 md:border-b-0 md:border-r md:last:border-r-0 ${selected ? "bg-blue-50 text-blue-700 after:absolute after:inset-x-0 after:bottom-[-1px] after:h-[3px] after:bg-blue-600" : "bg-white text-slate-700"}`}
              id={`schema-rule-${tab.category}-tab`}
              key={tab.category}
              onClick={() => setActiveCategory(tab.category)}
              role="tab"
              type="button"
            >
              <span className={`grid size-10 shrink-0 place-items-center rounded-lg [&_svg]:size-5 ${selected ? "bg-blue-100 text-blue-700" : "bg-blue-50 text-blue-600"}`}>
                {tab.icon}
              </span>
              <span className="grid min-w-0 gap-1">
                <span className={`text-base font-extrabold ${selected ? "text-blue-700" : "text-slate-700"}`}>{tab.label}</span>
                <strong className="text-[22px] font-extrabold leading-tight text-slate-950">{tab.value}</strong>
              </span>
              <ChevronRight className={`size-[18px] transition-transform ${selected ? "rotate-90 text-blue-600" : "text-slate-400"}`} />
            </button>
          );
        })}
      </div>

      <div
        aria-labelledby={`schema-rule-${activeCategory}-tab`}
        className="bg-slate-50/60 px-5 py-5"
        id={`schema-rule-${activeCategory}-panel`}
        role="tabpanel"
      >
        <h3 className="mb-3 mt-0 text-[17px] font-extrabold text-slate-900">{activeTab.label} 상세</h3>
        <RuleDetailList category={activeCategory} details={activeDetails} />
      </div>
    </Panel>
  );
}

function RuleDetailList({ category, details }: { category: RuleCategory; details: RuleDetail[] }) {
  if (details.length === 0) {
    return (
      <div className="grid min-h-16 place-items-center rounded-md border border-dashed border-slate-300 bg-white px-4 text-[15px] font-semibold text-slate-500">
        설정된 {category === "transform" ? "변환 규칙" : category === "quality" ? "품질 규칙" : "실패 처리"}이 없습니다.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
      {details.map((detail, index) => (
        <div
          className="grid min-h-[58px] grid-cols-1 items-center gap-1 border-b border-slate-200 px-4 py-3 last:border-b-0 sm:grid-cols-[minmax(140px,0.32fr)_minmax(0,1fr)_minmax(120px,auto)] sm:gap-4"
          key={`${detail.field}-${detail.note}-${index}`}
        >
          <code className="min-w-0 truncate text-sm font-bold text-blue-950">{detail.field}</code>
          <span className="text-[15px] font-bold text-slate-800">{detail.value}</span>
          <span className={`text-sm font-semibold sm:text-right ${detail.tone === "continue" ? "text-emerald-700" : detail.tone === "stop" ? "text-red-600" : "text-slate-500"}`}>
            {detail.note}
          </span>
        </div>
      ))}
    </div>
  );
}

function transformDetail(step: TransformStepDraft): RuleDetail {
  const isSqlExpression = step.operation.toLowerCase().replace(/[^a-z0-9]+/g, "_").includes("sql_expression");
  return {
    field: step.output || step.input || "전체 필드",
    note: transformTypeLabel(step),
    value: isSqlExpression && step.params
      ? step.params
      : step.label || `${step.input || "필드"}에 변환 규칙 적용`,
  };
}

function qualityDetail(rule: QualityRuleDraft): RuleDetail {
  return {
    field: rule.targetColumn || "전체 필드",
    note: QUALITY_RULE_LABELS[rule.validationType],
    value: describeQualityRule(rule),
  };
}

function failurePolicyDetails(applications: FailurePolicyApplication[]): RuleDetail[] {
  const grouped = new Map<string, FailurePolicyApplication[]>();
  applications.forEach((application) => {
    const current = grouped.get(application.action) ?? [];
    current.push(application);
    grouped.set(application.action, current);
  });

  return Array.from(grouped.entries()).map(([action, items]) => ({
    field: Array.from(new Set(items.map((item) => item.target).filter(Boolean))).join(", ") || "전체 필드",
    note: FAILURE_ACTION_LABELS[action] ?? action,
    tone: action === "Warn" ? "continue" : action === "Fail Run" ? "stop" : undefined,
    value: FAILURE_ACTION_DESCRIPTIONS[action] ?? "설정한 실패 처리 정책을 적용합니다.",
  }));
}

function describeQualityRule(rule: QualityRuleDraft) {
  if (rule.validationType === "Not Null") return "빈 값이 아닌지 확인합니다.";
  if (rule.validationType === "Range Check") {
    const [minimum, maximum] = String(rule.params ?? "").split(",").map((value) => value.trim());
    if (minimum && maximum) return `${formatNumericValue(minimum)}~${formatNumericValue(maximum)} 범위인지 확인합니다.`;
    return "설정한 최솟값과 최댓값 범위인지 확인합니다.";
  }
  if (rule.validationType === "Regex Match") return "지정한 문자 형식과 일치하는지 확인합니다.";
  return "허용된 값만 포함하는지 확인합니다.";
}

function transformTypeLabel(step: TransformStepDraft) {
  const labels: Record<TransformStepDraft["kind"], string> = {
    cast: "형식 변환",
    derive: "계산 필드",
    jsonPath: "JSON 값 추출",
    mask: "민감 정보 마스킹",
    rename: "필드명 변경",
    trim: "문자열 정리",
  };
  return labels[step.kind] ?? "필드 변환";
}

function formatNumericValue(value: string) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toLocaleString("ko-KR") : value;
}
