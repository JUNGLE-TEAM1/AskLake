export type DashboardAssistantMode = "dashboard_question" | "visualization_request";

type DashboardAssistantIntentContext = {
  hasSelectedWidget?: boolean;
  previousUserPrompts?: readonly string[];
};

const WIDGET_TARGET_PATTERN = /(위젯|차트|그래프|시각화|막대|꺾은선|선형|영역|도넛|원형|파이|트리맵|히트맵|메트릭|지표|표|테이블|widget|chart|graph|visuali[sz]|bar|line|area|donut|pie|treemap|heatmap|metric|table)/i;
const MUTATION_PATTERN = /(바꿔|변경|수정|만들|추가|생성|업데이트|전환|구성|설정|그려|보여|표시|change|update|create|add|make|draw|show|display|plot)/i;
const TARGETED_REQUEST_PATTERN = /(해\s*줘|please)/i;
const EXPLANATION_PATTERN = /(왜|이유|원인(?:을|이)?\s*(?:알려|설명)|설명해|요약해|알려줘|what caused|why|explain|summari[sz]e|tell me)/i;
const DISPLAY_PATTERN = /(보여|그려|시각화|표시|show|display|plot|visuali[sz]e)/i;
const ANALYTICAL_SHAPE_PATTERN = /(별|추이|분포|비교|현황|상위|하위|trend|by\s+[\p{L}\p{N}_-]+|distribution|comparison|top|bottom)/iu;
const ANALYTICAL_VALUE_PATTERN = /(매출|수익|주문|비용|고객|재고|배송|수량|건수|비율|평균|합계|revenue|sales|order|cost|customer|inventory|shipment|count|rate|average|total)/i;
const FOLLOW_UP_EXECUTION_PATTERN = /(랜덤(?:으로)?\s*(?:진행|해|만들)|그걸로|그대로|이걸로|저걸로|계속\s*(?:진행|해)|진행해\s*줘|만들어\s*줘|해\s*줘|go ahead|proceed|use (?:that|it)|continue)/i;
const PREVIOUS_DATA_TARGET_PATTERN = /(필드|컬럼|열|데이터셋|dataset|field|column|[\p{L}\p{N}]+_[\p{L}\p{N}_-]+)/iu;

function recentUserPrompts(previousUserPrompts: readonly string[] = []) {
  return previousUserPrompts
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(-2);
}

export function isContextualVisualizationFollowUp(
  prompt: string,
  previousUserPrompts: readonly string[] = [],
) {
  const normalizedPrompt = prompt.trim();
  if (!normalizedPrompt || EXPLANATION_PATTERN.test(normalizedPrompt)) return false;
  if (!FOLLOW_UP_EXECUTION_PATTERN.test(normalizedPrompt)) return false;
  return recentUserPrompts(previousUserPrompts).some((item) => PREVIOUS_DATA_TARGET_PATTERN.test(item));
}

export function buildDashboardAssistantRequestPrompt(
  prompt: string,
  previousUserPrompts: readonly string[] = [],
) {
  const normalizedPrompt = prompt.trim();
  const recentPrompts = recentUserPrompts(previousUserPrompts);
  if (!isContextualVisualizationFollowUp(normalizedPrompt, recentPrompts)) return normalizedPrompt;
  const previousContext = recentPrompts
    .map((item) => `- ${item.slice(0, 500)}`)
    .join("\n");
  return `이전 사용자 요청:\n${previousContext}\n\n현재 사용자 요청:\n${normalizedPrompt}`;
}

export function isWidgetMutationPrompt(
  prompt: string,
  { hasSelectedWidget = false }: DashboardAssistantIntentContext = {},
) {
  const normalizedPrompt = prompt.trim();
  if (!normalizedPrompt || EXPLANATION_PATTERN.test(normalizedPrompt)) return false;

  const hasMutationVerb = MUTATION_PATTERN.test(normalizedPrompt);
  if (
    WIDGET_TARGET_PATTERN.test(normalizedPrompt)
    && (hasMutationVerb || TARGETED_REQUEST_PATTERN.test(normalizedPrompt))
  ) return true;
  if (hasSelectedWidget && hasMutationVerb) return true;

  return DISPLAY_PATTERN.test(normalizedPrompt)
    && (ANALYTICAL_SHAPE_PATTERN.test(normalizedPrompt) || ANALYTICAL_VALUE_PATTERN.test(normalizedPrompt));
}

export function classifyDashboardAssistantMode(
  prompt: string,
  context: DashboardAssistantIntentContext = {},
): DashboardAssistantMode {
  if (isContextualVisualizationFollowUp(prompt, context.previousUserPrompts)) {
    return "visualization_request";
  }
  return isWidgetMutationPrompt(prompt, context) ? "visualization_request" : "dashboard_question";
}
