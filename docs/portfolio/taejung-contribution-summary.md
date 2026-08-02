# AskLake 개인 기여와 검증 근거

> 이 문서는 원시 PR과 대형 diff를 읽기 전에 문제, 개인 책임, 팀·AI 기여 경계와 검증 범위를 파악하기 위한 안내서입니다. 내용은 2026-08-02 기준 `JUNGLE-TEAM1/AskLake`의 `main`(`192ec5e64bc06a54564dd47d47681597f53fe1fc`)과 공개 GitHub 기록을 대조해 작성했습니다.

## 30초 요약

AskLake는 여러 경로의 데이터를 수집·처리·저장하고, Catalog·SQL·Dashboard에서 활용하도록 연결한 데이터 플랫폼 MVP입니다. 프로젝트는 개발 중 한 차례 재시작됐습니다. 재시작 전 `NMM_team1`에는 협업 하네스의 설계·팀 도입·온보딩 기록이, 최종 `AskLake`에는 권한·감사와 Kafka·SQL·Trino·EKS의 구현·검증 기록이 남아 있습니다.

제가 가장 깊게 고민하고 직접 주도한 영역은 **협업 하네스의 문제 정의, 도입, 운영 실패 분석과 경량화**입니다. 플랫폼 기능과 인프라 설정은 AI 보조 구현의 비중이 높았습니다. 이 영역에서는 모든 코드를 혼자 직접 작성했다고 설명하지 않고, 요구사항과 서비스 계약을 구조화하고 구현 선택을 검토하며, 생성된 변경을 통합해 오류·복구 조건을 검증한 범위로 설명합니다.

이 문서는 MVP와 제한된 검증 결과를 production 운영 성과로 확대하지 않습니다. 특히 SQL의 제한된 평가 결과, Kafka offset 상한, Trino worker 수를 일반 정확도·처리량·성능 개선 수치로 사용하지 않습니다.

## 두 코드베이스와 프로젝트 재시작

| 코드베이스 | 프로젝트에서의 위치 | 이 문서에서 읽을 근거 |
| --- | --- | --- |
| [`NMM_team1`](https://github.com/JUNGLE-TEAM1/NMM_team1) | 재시작 전 코드베이스 | 협업 하네스의 문서 계층, 변경 전파, 팀 사용 가이드와 책임 경계 |
| [`AskLake`](https://github.com/JUNGLE-TEAM1/AskLake) | 재시작 후 최종 코드베이스 | 권한·감사, 배포 검증, Kafka·SQL·Trino·EKS 구현과 검증 |

두 저장소의 변경량을 하나의 연속된 개인 구현량으로 합산하지 않습니다. 하네스에 관한 주장은 `NMM_team1`의 문서·PR로, 플랫폼에 관한 주장은 최종 `AskLake`의 PR·개인 커밋과 검증 문서로 각각 확인합니다.

## 개인·팀·AI 역할

| 구분 | 책임과 범위 |
| --- | --- |
| 직접 주도 | 하네스의 문제 정의, 문서 계층과 변경 전파 구조 설계, 팀 도입·운영, 반복 문의 대응, 온보딩 문서 보강, 실패 원인 분석과 경량화 방향 결정 |
| AI 활용과 개인 책임 | 권한·감사, 배포·Kafka·SQL·Trino 작업의 요구사항·우선순위·계약·완료 기준 정의, 선택지의 장단점 검토, AI 보조 구현의 통합, 오류 분석·복구와 검증 |
| 팀 기반 | 제품 목표와 공통 도메인 합의, 다른 팀원의 선행 기능과 공통 인프라, 목표 상태·상태 리비전·펜싱의 최초 계약, 최초 Query AI, 후속 join-aware v3와 Kafka revision 기반 SQL Job 자동 갱신 |
| 설명 원칙 | 코드 줄 수나 AI 생성량이 아니라 제가 정한 경계, 직접 확인한 실패 조건, 공개 근거와 남아 있는 한계를 중심으로 설명 |

## 3분 읽기 경로

1. 위의 `30초 요약`과 `개인·팀·AI 역할`에서 주장 범위를 먼저 확인합니다.
2. 하네스는 [3분 사용 가이드](https://github.com/JUNGLE-TEAM1/NMM_team1/blob/c28d4bdd318179c4e76a3dea07bd1dc0c048942b/docs/reports/collaboration-harness-team-usage-guide.md#2-3분-요약)와 [PR #272](https://github.com/JUNGLE-TEAM1/NMM_team1/pull/272)를 읽습니다.
3. 거버넌스는 [PR #473](https://github.com/JUNGLE-TEAM1/AskLake/pull/473)과 [PR #1025](https://github.com/JUNGLE-TEAM1/AskLake/pull/1025)에서 권한 판정과 과거 감사 값 호환 범위를 확인합니다.
4. 배포·Kafka는 [PR #957](https://github.com/JUNGLE-TEAM1/AskLake/pull/957)과 [PR #516](https://github.com/JUNGLE-TEAM1/AskLake/pull/516), SQL·Trino는 [PR #975](https://github.com/JUNGLE-TEAM1/AskLake/pull/975)와 [분산 검증 문서](https://github.com/JUNGLE-TEAM1/AskLake/blob/ef4631564741dcc5d477f1c4832dceac487902bc/docs/eks-trino-distributed-phase0.md#9-최초-2-worker-live-분산장애-절차역사-evidence)를 봅니다.
5. 이후 세부 구현이 필요할 때만 아래 본문과 고정 SHA 표로 내려갑니다. 공개 실행 기록이 없는 결과는 사후 추정으로 채우지 않습니다.

## 협업 하네스: 문맥 자동화에서 사람이 이해하는 운영 구조로

### 1. 흩어지는 프로젝트 문맥을 계층과 작업 공간으로 연결했습니다

AI 대화와 브랜치가 바뀔 때마다 목표·결정·현재 상태를 다시 설명해야 했고, 과거 판단과 검증 결과도 여러 문서에 흩어졌습니다. 이를 줄이기 위해 요구사항·제품 기획, 아키텍처·인터페이스, 인수·회귀·수동 검증 문서를 서로 다른 계층으로 나눴습니다. 변경이 생기면 모든 문서를 다시 쓰는 대신, 변경이 시작된 가장 이른 계층에서 실제 영향을 받는 하위 문서만 추적하도록 **라우팅 기반 변경 전파**를 적용했습니다.

브랜치 작업은 공통 문서를 즉시 수정하지 않고 별도 workspace에서 계획·판단·검증·동기화 상태를 관리했습니다. 프로젝트 기준을 바꾸는 결정만 Source of Truth에 반영해, 동시에 진행되는 작업이 공통 문맥을 무분별하게 덮어쓰는 문제를 줄이려 했습니다.

- [문서 계층과 변경 전파 경로 — 최초 도입 커밋 `ef6e527`](https://github.com/JUNGLE-TEAM1/NMM_team1/blob/ef6e527ec5dd0b0afcc8b68eb9faecdee34ae35b/docs/00-layer-map.md#2-change-propagation-paths)

### 2. 빠른 개발을 돕던 도구가 제작자 병목을 만들었습니다

문맥을 저장하고 공유하자 팀이 기능을 빠르게 이어 붙일 수 있었습니다. 그러나 저장된 전제를 사람이 충분히 이해하지 않아도 개발이 진행되는 것처럼 보이는 문제가 생겼습니다. 팀원은 하네스를 편리한 프로그램으로 받아들인 반면, 저는 사용자가 문맥과 책임을 이해하고 필요하면 함께 고치는 운영 도구로 생각했습니다. 이 인식 차이 때문에 예외 문의와 수정 요청이 제작자인 제게 집중됐고, 제가 빠르게 대응할수록 운영 지식도 한 사람에게 모였습니다.

저는 사용 설명을 제공하지 않은 채 도구만 전달한 것은 아닙니다. 직접 문의에 답하고 문제를 수정하는 한편, 반복되는 설명을 재사용 가능한 문서로 옮겼습니다. 445줄의 초보자 가이드에서 시작해 읽는 순서, 3분 요약, 자연어 요청 예시, Phase·PR 흐름, FAQ, 사람과 AI의 책임을 포함한 2,139줄의 팀 사용 가이드로 확장했습니다. 이후 AI 답변의 중립성과 사람이 문맥 충분성을 확인할 책임도 별도 PR에서 보강했습니다.

- [최종 팀 사용 가이드의 3분 요약](https://github.com/JUNGLE-TEAM1/NMM_team1/blob/c28d4bdd318179c4e76a3dea07bd1dc0c048942b/docs/reports/collaboration-harness-team-usage-guide.md#2-3분-요약)
- [최초 팀 사용 가이드 — PR #249](https://github.com/JUNGLE-TEAM1/NMM_team1/pull/249)
- [AI 답변의 중립적 판단 기준 — PR #259](https://github.com/JUNGLE-TEAM1/NMM_team1/pull/259)
- [문맥 충분성과 사람 책임 보강 — PR #272](https://github.com/JUNGLE-TEAM1/NMM_team1/pull/272)

가이드를 확장한 노력만으로 팀의 독립 운영을 만들지는 못했습니다. 별도의 실습·점진적 도입·이해도 확인을 충분히 진행하지 못했고, 설명 문서 자체도 사람이 한 번에 읽기 어려운 규모가 됐습니다. 공개 이력만으로 일관되게 재현하기 어려운 개인 커밋 개수나 문의 횟수는 성과 지표로 사용하지 않습니다.

### 3. 강제할 조건과 사람이 이해해야 할 문맥을 분리했습니다

PR 확인, 직접 push 제한, 문서 동기화 같은 모든 협업 규칙을 자연어 문서로 강제하려 하자 예외를 막기 위한 규칙이 계속 늘었습니다. 사람이나 AI가 급한 요청을 우선하면 자연어 규칙은 우회될 수 있었고, 한 예외를 막을수록 다른 예외가 생겼습니다.

그래서 역할을 다시 나눴습니다.

- **시스템 가드레일:** 기계가 안정적으로 확인할 수 있고 누락 시 피해가 큰 브랜치·테스트·빌드·스모크 테스트·배포 전제
- **하네스 프로토콜:** 사람이 판단해야 하는 목표·범위·전제·근거·검증 결과·복구 경로
- **팀 합의:** 리뷰 문화, 책임 귀속, 예외 허용처럼 자동화만으로 결정할 수 없는 사항

공통 하네스에는 팀 전체가 알아야 하는 목적·범위, 합의된 결정, 구현 간 계약과 필수 검증을 우선해 남겼습니다. AI가 사람 대신 모든 작업 문맥과 행동 이력을 기억하는 방향은 줄였습니다. 팀 회고상 이후 일부 작업에서는 팀원이 필요한 문제 문맥을 직접 AI에 제공하고 결과를 검토하는 방향으로 바뀌었지만, 독립 운영 향상을 정량적으로 측정한 자료는 없습니다.

- [하네스 프로토콜과 시스템 가드레일의 현재 책임 분리](https://github.com/JUNGLE-TEAM1/AskLake/blob/192ec5e64bc06a54564dd47d47681597f53fe1fc/docs/system-guardrails.md#1-responsibility-split)

이 과정을 통해 얻은 결론은 “AI가 문맥을 많이 기억할수록 좋다”가 아닙니다. AI가 구현 속도를 높이더라도 사람은 목표, 도메인 전제, 근거와 최종 판단 책임을 유지해야 하며, 협업 도구는 그 책임을 없애는 대신 확인할 진입점을 제공해야 합니다.

## 권한·감사 거버넌스

### 1. 화면 표시와 실제 접근 통제를 분리했습니다

프론트엔드에서 버튼을 숨기는 것만으로 API 접근을 통제할 수 없습니다. 요청을 `주체(actor) → 자원(resource) → 행동(action)`으로 구조화하고, 백엔드에서 다시 판정하도록 연결했습니다.

일반 사용자의 권한은 allow-only 모델입니다. actor의 사용자 ID·이름·이메일, 소속 그룹·역할 또는 public principal 중 하나라도 대상 action을 허용하는 grant와 일치하면 허용합니다. `query`, `run`, `manage`, `delete`, `share`, `publish` 권한이 있으면 기본 조회도 가능하도록 계산합니다. 관리자는 role로, 자원 담당자는 owner fallback으로 별도 처리합니다.

사용자·그룹 차단과 resource lock은 grant 합집합과 분리된 거버넌스 계층입니다. 차단된 세션 사용자는 인증·적용 대상 자원 접근을 거부하고, 잠긴 자원은 `query`, `run`, `manage`, `delete`, `share`를 거부합니다. Dataset·Job·Dashboard·SQL의 주요 거부 경로는 백엔드 `403`과 감사 이벤트로 연결했습니다.

- [권한 판정·차단·잠금·감사 통합 — PR #473](https://github.com/JUNGLE-TEAM1/AskLake/pull/473)
- [현재 actor·grant 판정 코드](https://github.com/JUNGLE-TEAM1/AskLake/blob/192ec5e64bc06a54564dd47d47681597f53fe1fc/backend/app/core/auth_context.py)

### 2. 과거 감사 값 하나가 관리 화면 전체를 막지 않게 했습니다

저장된 감사 로그에는 `query_run`이 있었지만 새 API schema와 프론트엔드 타입에는 빠져 있었습니다. 이 불일치 때문에 감사 API가 실패했고, 관리 화면이 여러 초기 요청을 한 번에 처리하면서 정상인 사용자·그룹·권한 정보까지 모두 보이지 않을 수 있었습니다.

공통 `AuditTargetType`에 `query_run`을 포함하고, 앞으로의 writer는 알려진 enum만 저장하도록 제한했습니다. 과거 계약 밖 값은 삭제하거나 의미를 덮어쓰지 않고 읽는 시점에 `unknown`으로 변환하되, 원본을 `metadata.rawTargetType`에 보존했습니다. 관리 화면은 영역별 요청을 격리해 감사 로그 조회가 실패해도 다른 관리 정보와 마지막 성공한 감사 결과를 유지하도록 보완했습니다.

- [레거시 감사 값 호환과 관리 화면 실패 격리 — PR #1025](https://github.com/JUNGLE-TEAM1/AskLake/pull/1025)
- [현재 감사 타입 정규화와 원본 보존 코드](https://github.com/JUNGLE-TEAM1/AskLake/blob/192ec5e64bc06a54564dd47d47681597f53fe1fc/backend/app/repositories/audit_repository.py#L124-L146)

### 3. 이 구현의 범위

이 구현은 로컬 세션 인증을 사용하는 MVP의 allow-only 정책입니다. 다음은 완료 범위에 포함하지 않습니다.

- 명시적 deny와 조건부 정책
- 기업 IdP·SSO 연동과 production 보안 운영
- 동적으로 동기화되는 조직 디렉터리 전체
- 감사 로그의 장기 보존·SIEM 연계와 전체 과거 이력 UI

현재 사용자·그룹 활동 모달은 최근 감사 로그 100건을 받은 뒤 식별자가 일치하는 최대 10건을 표시하므로, 전체 이력을 제공하는 화면으로 설명하지 않습니다.

## 플랫폼 구현·운영 범위

### 1. 배포 명령의 성공보다 상태 수렴과 복구 조건을 확인했습니다

프로젝트 재시작 후에는 먼저 EC2 기반 MVP로 동작 기준선을 확보하고, 이를 복구 경로로 남긴 채 EKS 검증 범위를 넓혔습니다. 초기 재배포는 컨테이너 기동과 HTTP health를 중심으로 확인했지만, 실행 중인 Spark·Kafka Continuous에는 DB의 실행 의도, 실제 runner, runtime report와 checkpoint처럼 서로 수명이 다른 상태가 있었습니다. 일부 구성만 교체되면 처리 결과는 남아 있는데 제어 계층의 상태가 뒤처지거나, 오래된 worker 상태가 남는 문제가 발생했습니다.

목표 상태·상태 리비전·펜싱의 최초 공통 계약은 팀 기반입니다. 그 위에서 제가 보완한 범위는 다음과 같습니다.

- `start`뿐 아니라 `deploy`·`restart` 전에 metadata schema bootstrap을 실행하고, readiness record 기록 실패와 중지 EC2 진단을 검증 경로에 포함
- runner가 `UNKNOWN`이거나 terminal stale worker만 남은 경우 같은 fence에서 복구하고, 실제 runner 종료를 확인할 때까지 pause·stop을 완료 처리하지 않는 reconciliation 보완
- EKS Spark Driver의 비루트 UID 쓰기 권한, Pod-local manifest 전달 오류, JDBC Secret 중복 주입을 서로 다른 원인으로 분리해 복구

대표 근거:

- [배포 통합 후보의 readiness·schema·진단 보완 — PR #957](https://github.com/JUNGLE-TEAM1/AskLake/pull/957)
- [Continuous runner 상태 복구 — 개인 커밋 `d014efac`](https://github.com/JUNGLE-TEAM1/AskLake/commit/d014efac5e2018c22e7ae42c315e6bd78927690e)
- [Continuous stop 상태 수렴 — 개인 커밋 `3a5307d1`](https://github.com/JUNGLE-TEAM1/AskLake/commit/3a5307d18d51a19b6760491aa8b0e220f09bef7a)
- [EKS Spark runtime report·Secret 주입 복구 — PR #1174](https://github.com/JUNGLE-TEAM1/AskLake/pull/1174)

실제 적용·전환·복구에는 사람의 승인과 배포 환경 확인이 포함됐습니다. 이 작업을 완전 자동 CD, production 자동 rollback 또는 EKS 전환 전체의 단독 설계·운영으로 설명하지 않습니다.

### 2. Kafka의 유한 실행과 장기 실행이 상태를 함께 소유하지 않게 했습니다

기존 Kafka Snapshot은 스케줄 실행마다 정해진 offset 범위를 소비하고 결과와 offset을 확정한 뒤 종료하는 유한 작업이었습니다. 이를 없애지 않고 `snapshot | continuous` 실행 모드로 분리했습니다. Continuous에서는 Spark Structured Streaming worker가 bounded micro-batch를 반복하고 checkpoint를 기준으로 진행 상태를 보존하도록 control plane, 시작·일시정지·재개·중지, heartbeat와 worker 복구를 연결했습니다.

- [Kafka Snapshot의 offset·target·재시도 계약 — PR #456](https://github.com/JUNGLE-TEAM1/AskLake/pull/456)
- [Kafka Continuous 실행 생명주기 — PR #516](https://github.com/JUNGLE-TEAM1/AskLake/pull/516)
- [EKS Realtime Kafka 전환·복구 조건](https://github.com/JUNGLE-TEAM1/AskLake/blob/ef4631564741dcc5d477f1c4832dceac487902bc/docs/eks-realtime-kafka-v1-rollout.md#3-배포-전-gate)
- [격리 EKS canary와 production cutover 경계 — PR #1060](https://github.com/JUNGLE-TEAM1/AskLake/pull/1060)

초기 V1 설정의 `maxOffsetsPerTrigger=10,000`은 한 micro-batch 입력 상한이지 초당 처리량이 아닙니다. 성공한 10,000건 부하 artifact와 장기 production 처리량·지연 수치는 확인되지 않았습니다. PR #1060에 기록된 결과도 격리된 100건 canary의 lag 0·재시작 중복 0 확인이며 production cutover 완료나 exactly-once 분산 transaction으로 확대하지 않습니다.

### 3. SQL 생성과 실행 사이에 비용·권한·상태 경계를 추가했습니다

최초 Query AI backend는 다른 팀원이 구현했습니다. 저는 이후 Catalog의 schema·type·storage bytes·partition·key 정보를 prompt에 제공하고, SQLGlot으로 `SELECT *`, CROSS/key-less JOIN, partition column 함수, type 없는 시간 literal, 허용되지 않은 approximate aggregation과 중복 scan을 결정적으로 검사하는 cost-aware v2를 구현했습니다. 위반 시 전체 최대 1회의 교정만 허용하고, benchmark에서 정의한 모호 질문과 명시적인 선택 범위 밖 Dataset 요청 패턴은 provider 호출 전에 거부했습니다.

동일한 합성 fixture·질문 suite·provider/model·local Trino 조건에서 baseline은 12개 중 4개, cost-aware v2는 12개 시나리오를 통과했습니다. v2는 시나리오당 5회, 총 60회의 warm 평가에서 기록된 failure·timeout·regeneration이 없었습니다. 그러나 일부 시나리오는 SQL을 실행하지 않고 거부하는 것이 정답이었고, 100만 행 orders fixture의 물리 크기도 5,690,924 bytes(약 5.69MB)였습니다. 따라서 이 결과를 범용 정확도 100%, 대규모 운영 성능 또는 최적 실행 계획 생성으로 표현하지 않습니다.

생성된 SQL은 자동 실행하지 않습니다. Query Run 제출 전에 read-only·Dataset scope·권한을 다시 확인하고, plan·Catalog·Iceberg 물리 byte를 바탕으로 예상 scan을 계산했습니다. 임계치 이상이거나 추정할 수 없는 요청은 사용자·SQL·Dataset·유효시간에 묶인 확인 token을 요구했습니다. Query Run과 결과 collector는 idempotency key, advisory lock, lease generation으로 중복 제출과 오래된 worker의 결과 덮어쓰기를 제한했습니다.

- [Trino Query Run·결과 collector·권한 재검증 — PR #494](https://github.com/JUNGLE-TEAM1/AskLake/pull/494)
- [비용 인지형 SQL 생성과 제한 평가 — PR #975](https://github.com/JUNGLE-TEAM1/AskLake/pull/975)
- [SQL 평가 계약과 결과](https://github.com/JUNGLE-TEAM1/AskLake/blob/648fb0b04f19f5b204180dd628863206d3369c91/docs/nessie-sql-benchmark.md#cost-aware-v2)

### 4. Trino를 단일 coordinator에서 역할이 분리된 구성으로 검증했습니다

초기 EKS 기준선은 별도 worker 한 대가 아니라 coordinator가 query task도 수행하는 단일 process 구성이었습니다. 이를 coordinator Deployment 1개와 별도 worker Deployment로 분리하고, 최종 운영 계약에서는 worker Pod 2개를 고정하도록 구성했습니다. `system.runtime.nodes` 등록, non-coordinator worker의 Iceberg task 참여와 exact-UID worker 교체 뒤 재등록을 확인하는 절차를 연결했습니다.

- [coordinator·worker 분리 — 개인 커밋 `a3a16575`](https://github.com/JUNGLE-TEAM1/AskLake/commit/a3a16575ff480f1d35c0b26138bdbb39da429f7f)
- [분산 검증 ACL 보완 — 개인 커밋 `018f40f5`](https://github.com/JUNGLE-TEAM1/AskLake/commit/018f40f5c28a0a8f97f92cf66178cf17a40ec749)
- [worker fixed-2 계약 — 개인 커밋 `8b4f78dc`](https://github.com/JUNGLE-TEAM1/AskLake/commit/8b4f78dc6c68ce49a3a8f08e8eb2e22f3b73718e)
- [역사적 `2→1→2` 절차와 최종 fixed-2 경계](https://github.com/JUNGLE-TEAM1/AskLake/blob/ef4631564741dcc5d477f1c4832dceac487902bc/docs/eks-trino-distributed-phase0.md#9-최초-2-worker-live-분산장애-절차역사-evidence)

여기서 worker 2개는 Kubernetes Pod replica 정책입니다. 물리 서버 2대, autoscaling, 처리량이나 지연시간 개선을 의미하지 않습니다. 당시 private 실행 receipt와 EKS cluster가 공개 재현 가능한 형태로 남아 있지 않으므로 운영 성능 근거로 사용하지 않습니다.

### 5. Airflow·Spark는 연결 경로를 통합한 범위로 설명합니다

배치 처리에서는 Airflow가 실행 순서와 상태를 조율하고 Spark가 처리한 물리 결과를 Iceberg·Catalog에 게시하는 경로를 기존 구성과 연결했습니다. Kafka Continuous와 EKS Spark에서도 제어 상태, 실제 runner, report·manifest, Catalog 공개 순서가 어긋나지 않는지를 중심으로 검증했습니다.

이는 Airflow scheduler나 Spark engine 내부를 직접 설계·최적화한 경험이 아닙니다. 엔진 내부 성능 개선, production scheduler 운영과 대규모 처리량 수치는 개인 기여 범위에서 제외합니다.

## 검증 결과와 확대하지 않는 범위

| 영역 | 공개 근거로 확인 가능한 내용 | 확대하지 않는 범위 |
| --- | --- | --- |
| 협업 하네스 | 문서 계층·변경 전파 설계, 초보자·팀 가이드, 책임 경계 보강 PR | 팀 이해도 향상률, 문의 감소율, 독립 운영 정량 성과 |
| 권한·감사 | allow-only grant 판정, 차단·잠금, 백엔드 403·감사 연결, legacy audit 호환과 화면 실패 격리 | deny·조건부 정책, IdP·SSO, production 보안·감사 운영 |
| 배포·복구 | deploy/readiness regression 기록, schema bootstrap, bounded diagnostic, Spark runtime 오류 복구 | 완전 자동 CD, 자동 production rollback, EKS 전체 단독 운영 |
| Kafka | Snapshot·Continuous 분리, checkpoint·worker lifecycle, 격리 100건 EKS canary | `10,000`을 TPS로 해석, 장기 production 처리량, production cutover 완료 |
| SQL | 제한된 동일 조건에서 baseline 4/12와 v2 12/12, case당 5회 평가 | 일반 정확도 100%, 대규모 운영 성능, 모든 60회를 실제 SQL 실행으로 해석 |
| Trino | coordinator/worker 역할 분리, fixed-2 구성과 장애·재등록 절차 | worker 증가에 따른 성능 개선, HPA·SLO, 공개 원시 실행 receipt |
| Airflow·Spark | 실행·상태·물리 결과·Catalog 공개의 통합 경로 | 엔진 내부 설계·최적화와 production scheduler 운영 |

PR 본문에 기록된 테스트 결과는 당시 브랜치와 환경의 검증 기록입니다. 이 문서를 작성하면서 전체 과거 실행 환경을 새로 재현한 것은 아니며, private credential·EKS cluster·Git 제외 receipt가 필요한 검증은 공개 저장소만으로 다시 실행할 수 없습니다.

## 대표 근거의 작성자·고정 revision

| 주제 | 작성자 | 공개 근거 | 병합 또는 고정 SHA |
| --- | --- | --- | --- |
| 하네스 역할 분리 | 박태정 | [개인 커밋](https://github.com/JUNGLE-TEAM1/NMM_team1/commit/8b89d80cc6eade40cc0465e03fc0a16f19a79196) | `8b89d80cc6eade40cc0465e03fc0a16f19a79196` |
| 팀 사용 가이드 | `tail1887` | [PR #249](https://github.com/JUNGLE-TEAM1/NMM_team1/pull/249) | `ee4b2e01ca8ccd8795d221c9b16a0f28a834ecde` |
| AI 판단 기준 | `tail1887` | [PR #259](https://github.com/JUNGLE-TEAM1/NMM_team1/pull/259) | `5aa4ca9937aaef8e8a83a7519f6f423ea7f15161` |
| 문맥 충분성 | `tail1887` | [PR #272](https://github.com/JUNGLE-TEAM1/NMM_team1/pull/272) | `c28d4bdd318179c4e76a3dea07bd1dc0c048942b` |
| 권한·감사 | `tail1887` | [PR #473](https://github.com/JUNGLE-TEAM1/AskLake/pull/473) | `266c2b07b7057b8d1b1019f38242b57201411ee0` |
| 감사 호환·실패 격리 | `tail1887` | [PR #1025](https://github.com/JUNGLE-TEAM1/AskLake/pull/1025) | `38517be9679584de8e362afff4eaaba34fd4e114` |
| 배포 검증 | `tail1887` | [PR #957](https://github.com/JUNGLE-TEAM1/AskLake/pull/957) | `b5a7c41d076df73ec86f1a3223061cdea4f19e60` |
| Kafka Snapshot | `tail1887` | [PR #456](https://github.com/JUNGLE-TEAM1/AskLake/pull/456) | `cf1d03de1dcf2fe2968423a9ccef36af61a3251d` |
| Kafka Continuous | `tail1887` | [PR #516](https://github.com/JUNGLE-TEAM1/AskLake/pull/516) | `9c42637db0587804ec5cb78900bedb4a4cd563e6` |
| Trino Query Run | `tail1887` | [PR #494](https://github.com/JUNGLE-TEAM1/AskLake/pull/494) | `dc604280d0d607c2bfe3e7d715a6d61511d304b2` |
| SQL 평가·guard | `tail1887` | [PR #975](https://github.com/JUNGLE-TEAM1/AskLake/pull/975) | `283b32ef2df3db8e253429971a229bff9035059e` |
| EKS Kafka canary | `tail1887` | [PR #1060](https://github.com/JUNGLE-TEAM1/AskLake/pull/1060) | `6943a9764e1b0152575802ba03ac8a7d85c6915a` |
| EKS Spark 복구 | `tail1887` | [PR #1174](https://github.com/JUNGLE-TEAM1/AskLake/pull/1174) | `fdc5c2e27ba9b363a3233fbab582e88fe422bf73` |
