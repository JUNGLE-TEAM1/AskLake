import { BarChart3, BookOpen, Bot, Database, Settings, TerminalSquare } from "lucide-react";
import type { FlowId, NavItem } from "../types";

export const steps = ["소스", "처리", "스케줄", "권한", "타겟", "검토"];

export const flowTabs: Array<{ id: FlowId; label: string; stepIndex: number }> = [
  { id: "jobs", label: "작업 목록", stepIndex: 0 },
  { id: "jobDetail", label: "작업 상세", stepIndex: 0 },
  { id: "jobRuns", label: "실행 이력", stepIndex: 0 },
  { id: "source", label: "소스 연결", stepIndex: 0 },
  { id: "recordParsing", label: "레코드 구조화", stepIndex: 1 },
  { id: "schema", label: "스키마 확인", stepIndex: 1 },
  { id: "rules", label: "변환 규칙", stepIndex: 1 },
  { id: "repeat", label: "반복 실행", stepIndex: 2 },
  { id: "manual", label: "수동 실행", stepIndex: 2 },
  { id: "target", label: "타겟 설정", stepIndex: 4 },
  { id: "permission", label: "권한 설정", stepIndex: 3 },
  { id: "review", label: "검토 및 생성", stepIndex: 5 },
  { id: "profile", label: "내 프로필", stepIndex: 0 },
  { id: "login", label: "로그인", stepIndex: 0 },
];

export const navItems = [
  { id: "ingest", label: "수집/처리", icon: Database, flow: "jobs" },
  { id: "catalog", label: "검색/카탈로그", icon: BookOpen, flow: "catalog" },
  { id: "sql", label: "SQL 분석", icon: TerminalSquare, flow: "sql" },
  { id: "dashboard", label: "대시보드", icon: BarChart3, flow: "dashboard" },
  { id: "ai", label: "AI 활용", icon: Bot, flow: "ai" },
  { id: "admin", label: "관리", icon: Settings, flow: "admin" },
] satisfies NavItem[];

export const ingestFlows: FlowId[] = ["jobs", "jobDetail", "jobRuns", "source", "recordParsing", "schema", "repeat", "manual", "target", "permission", "review"];
export const jobManagerFlows: FlowId[] = ["jobs", "jobDetail", "jobRuns"];
export const wizardFlows: FlowId[] = ["source", "recordParsing", "schema", "repeat", "manual", "permission", "target", "review"];

export const summaryByFlow: Record<FlowId, Array<[string, string]>> = {
  jobs: [
    ["전체 작업", "0"],
    ["실행 중", "0"],
    ["스케줄됨", "0"],
    ["실패", "0"],
    ["최신 아님", "0"],
  ],
  jobDetail: [
    ["작업명", "생성 전"],
    ["상태", "-"],
    ["Owner", "-"],
    ["타겟", "-"],
    ["실패 규칙", "-"],
  ],
  jobRuns: [
    ["총 실행", "0건"],
    ["7일 성공률", "-"],
    ["평균 소요", "-"],
    ["최근 실패", "-"],
    ["실패 단계", "-"],
  ],
  catalogDetail: [
    ["데이터셋", "생성 전"],
    ["Owner", "-"],
    ["Layer", "-"],
    ["스키마", "-"],
    ["리니지", "-"],
  ],
  source: [
    ["선택 커넥터", "MinIO"],
    ["연결 상태", "테스트 필요"],
    ["감지 파일", "0개"],
    ["인증 방식", "MinIO/S3 액세스 키"],
    ["다음 단계", "스키마 확인"],
  ],
  recordParsing: [
    ["입력 포맷", "TXT"],
    ["구분자", "연속 공백"],
    ["샘플 검증", "대기"],
    ["출력 필드", "0개"],
    ["다음 단계", "스키마 확인"],
  ],
  schema: [
    ["샘플 Row", "0"],
    ["출력 필드", "0개"],
    ["평균 Confidence", "-"],
    ["검토 필요", "-"],
    ["다음 단계", "스케줄"],
  ],
  rules: [
    ["변환 규칙", "스키마 화면 통합"],
    ["영향 컬럼", "-"],
    ["샘플 적용률", "-"],
    ["Invalid Rows", "-"],
    ["다음 단계", "스케줄"],
  ],
  repeat: [
    ["실행 일정", "반복 실행"],
    ["다음 실행", "설정 후 계산"],
    ["겹침 처리", "이전 Run 기준"],
    ["실패 재시도", "기본 정책"],
    ["상태", "생성 대기"],
  ],
  manual: [
    ["시작 조건", "필요 시 즉시 실행"],
    ["다음 실행", "없음"],
    ["실패 재시도", "기본 정책"],
    ["상태", "대기"],
  ],
  target: [
    ["저장소", "S3 Gold"],
    ["포맷", "Parquet"],
    ["파티션", "설정 전"],
    ["RAG 인덱스", "선택"],
    ["진행률", "-"],
  ],
  permission: [
    ["선택 권한", "0개"],
    ["검토 필요", "0건"],
    ["공개 범위", "조직 내부"],
    ["승인자", "Data Owner"],
    ["상태", "권한 확인 전"],
  ],
  review: [
    ["파이프라인", "생성 전"],
    ["소스", "MinIO"],
    ["스케줄", "설정 전"],
    ["권한", "설정 전"],
    ["타겟", "설정 전"],
  ],
  catalog: [
    ["해당 파트", "중립"],
    ["표시 화면", "검색 / 상세 / 리니지"],
    ["상태", "통합 예정"],
    ["연결", "생성된 데이터셋"],
    ["다음 단계", "SQL 분석"],
  ],
  sql: [
    ["해당 파트", "현재"],
    ["표시 화면", "SQL Editor"],
    ["상태", "통합 예정"],
    ["입력", "Catalog 데이터셋"],
    ["출력", "결과 / Export"],
  ],
  dashboard: [
    ["해당 파트", "선호"],
    ["표시 화면", "Dashboard Builder"],
    ["상태", "통합 예정"],
    ["입력", "SQL 결과"],
    ["출력", "Published Dashboard"],
  ],
  ai: [
    ["해당 영역", "AI 활용"],
    ["표시 기능", "RAG / AI 질의"],
    ["상태", "아직 연결 없음"],
    ["입력", "Lake 데이터셋"],
    ["권한", "사용자별 접근 제어"],
  ],
  admin: [
    ["해당 영역", "관리"],
    ["표시 기능", "권한 / 감사 로그"],
    ["상태", "아직 연결 없음"],
    ["대상", "사용자 / 그룹 / API"],
    ["로그", "Audit Log"],
  ],
  profile: [
    ["해당 영역", "내 프로필"],
    ["표시 기능", "계정 / 그룹 / 권한"],
    ["상태", "연결됨"],
    ["입력", "현재 Actor"],
    ["API", "/api/users/me"],
  ],
  login: [
    ["해당 영역", "계정"],
    ["표시 기능", "로그인 / 회원가입"],
    ["상태", "연결됨"],
    ["입력", "이메일 / 비밀번호"],
    ["API", "/api/auth"],
  ],
};
