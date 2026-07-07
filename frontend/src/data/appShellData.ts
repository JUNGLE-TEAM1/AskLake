import { BarChart3, BookOpen, Bot, Database, Settings, TerminalSquare } from "lucide-react";
import type { FlowId, NavItem } from "../types";

export const steps = ["소스", "처리", "스케줄", "권한", "타겟", "검토"];

export const flowTabs: Array<{ id: FlowId; label: string; stepIndex: number }> = [
  { id: "jobs", label: "작업 목록", stepIndex: 0 },
  { id: "jobsTableDemo", label: "표형 데모", stepIndex: 0 },
  { id: "jobDetail", label: "작업 상세", stepIndex: 0 },
  { id: "jobRuns", label: "실행 이력", stepIndex: 0 },
  { id: "source", label: "소스 연결", stepIndex: 0 },
  { id: "schema", label: "스키마 추론", stepIndex: 1 },
  { id: "rules", label: "룰 적용", stepIndex: 1 },
  { id: "repeat", label: "반복 스케줄", stepIndex: 2 },
  { id: "manual", label: "스케줄 없음", stepIndex: 2 },
  { id: "once", label: "예약 1회 실행", stepIndex: 2 },
  { id: "target", label: "타겟 설정", stepIndex: 4 },
  { id: "permission", label: "권한 설정", stepIndex: 3 },
  { id: "review", label: "검토 및 생성", stepIndex: 5 },
];

export const navItems = [
  { id: "ingest", label: "수집/처리", icon: Database, flow: "jobs" },
  { id: "catalog", label: "검색/카탈로그", icon: BookOpen, flow: "catalog" },
  { id: "sql", label: "SQL 분석", icon: TerminalSquare, flow: "sql" },
  { id: "dashboard", label: "대시보드", icon: BarChart3, flow: "dashboard" },
  { id: "ai", label: "AI 활용", icon: Bot, flow: "ai" },
  { id: "admin", label: "관리", icon: Settings, flow: "admin" },
] satisfies NavItem[];

export const ingestFlows: FlowId[] = ["jobs", "jobsTableDemo", "jobDetail", "jobRuns", "source", "schema", "rules", "repeat", "manual", "once", "target", "permission", "review"];
export const jobManagerFlows: FlowId[] = ["jobs", "jobsTableDemo", "jobDetail", "jobRuns"];
export const wizardFlows: FlowId[] = ["source", "schema", "rules", "repeat", "manual", "once", "permission", "target", "review"];

export const summaryByFlow: Record<FlowId, Array<[string, string]>> = {
  jobs: [
    ["전체 작업", "0"],
    ["실행 중", "0"],
    ["스케줄됨", "0"],
    ["실패", "0"],
    ["최신 아님", "0"],
  ],
  jobsTableDemo: [
    ["표시 방식", "Table"],
    ["핵심 컬럼", "7개"],
    ["실패 로그", "요약 표시"],
    ["원문", "모달"],
    ["상태", "검토용"],
  ],
  jobDetail: [
    ["작업명", "생성 전"],
    ["상태", "-"],
    ["Owner", "-"],
    ["타깃", "-"],
    ["실패 규칙", "-"],
  ],
  jobRuns: [
    ["총 실행", "0회"],
    ["7일 성공률", "-"],
    ["평균 소요", "-"],
    ["최근 실패", "-"],
    ["실패 단계", "-"],
  ],
  catalogDetail: [
    ["데이터셋", "생성 전"],
    ["Owner", "-"],
    ["Layer", "-"],
    ["품질", "-"],
    ["리니지", "-"],
  ],
  source: [
    ["선택 커넥터", "File / S3"],
    ["연결 상태", "S3 연결 테스트 대기"],
    ["감지 파일", "0개"],
    ["인증 방식", "S3 호환 access key"],
    ["다음 단계", "스키마 추론"],
  ],
  schema: [
    ["샘플 Row", "0"],
    ["추론 필드", "0개"],
    ["평균 Confidence", "-"],
    ["검토 필요", "-"],
    ["다음 단계", "룰 적용"],
  ],
  rules: [
    ["활성 규칙", "5개"],
    ["영향 컬럼", "12/48"],
    ["품질 통과율", "94.2%"],
    ["Invalid Rows", "3건"],
    ["다음 단계", "스케줄"],
  ],
  repeat: [
    ["실행 방식", "반복 스케줄"],
    ["시작 일시", "2026.07.02 10:30"],
    ["종료 일시", "종료일 없음"],
    ["다음 실행", "2026.07.09 10:30"],
    ["상태", "생성 대기"],
  ],
  manual: [
    ["실행 방식", "스케줄 없음"],
    ["시작 조건", "사용자 직접 실행"],
    ["재시도", "3회"],
    ["제한 시간", "60분"],
    ["상태", "저장 대기"],
  ],
  once: [
    ["실행 방식", "예약 1회 실행"],
    ["실행 일시", "2026.07.03 10:30"],
    ["시간대", "Asia/Seoul"],
    ["재시도", "3회"],
    ["상태", "예약 대기"],
  ],
  target: [
    ["저장소", "S3 Gold"],
    ["포맷", "Parquet"],
    ["파티션", "year/month/region"],
    ["RAG 색인", "활성화"],
    ["진행률", "85%"],
  ],
  permission: [
    ["선택된 권한", "3개 그룹"],
    ["검토 필요", "1건"],
    ["공개 범위", "조직 내부"],
    ["승인자", "Data Owner"],
    ["상태", "권한 확인 중"],
  ],
  review: [
    ["파이프라인", "pair_a_customer_review_gold"],
    ["소스", "S3 / m3-raw"],
    ["스케줄", "매주 목요일 10:30"],
    ["권한", "분석가 외 2건"],
    ["타겟", "S3 Gold / Parquet"],
  ],
  catalog: [
    ["담당 파트", "중일"],
    ["핵심 화면", "검색 / 상세 / 리니지"],
    ["상태", "통합 예정"],
    ["연결", "생성된 데이터셋"],
    ["다음 단계", "SQL 분석"],
  ],
  sql: [
    ["담당 파트", "원재"],
    ["핵심 화면", "SQL Editor"],
    ["상태", "통합 예정"],
    ["입력", "Catalog 데이터셋"],
    ["출력", "결과 / Export"],
  ],
  dashboard: [
    ["담당 파트", "선호"],
    ["핵심 화면", "Dashboard Builder"],
    ["상태", "통합 예정"],
    ["입력", "SQL 결과"],
    ["출력", "Published Dashboard"],
  ],
  ai: [
    ["담당 영역", "AI 활용"],
    ["핵심 기능", "RAG / AI 질의"],
    ["상태", "아직 연결 없음"],
    ["입력", "Lake 데이터셋"],
    ["권한", "사용자별 접근 제어"],
  ],
  admin: [
    ["담당 영역", "관리"],
    ["핵심 기능", "권한 / 감사 로그"],
    ["상태", "아직 연결 없음"],
    ["대상", "사용자 / 그룹 / API"],
    ["로그", "Audit Log"],
  ],
};
