# AskLake 아키텍처 개편용 Pro 프롬프트 묶음

이 디렉터리는 AskLake의 현재 배포 코드와 스파게티 감사 결과를 바탕으로, Pro 모델에게 전체 아키텍처 개편안과 실행 가능한 마이그레이션 계획을 요청하기 위한 프롬프트 묶음이다.

## 파일 구성

1. [01-master-architecture-modernization-prompt.md](./01-master-architecture-modernization-prompt.md)
   - 전체 현황 분석, 대안 비교, 목표 아키텍처, 단계별 마이그레이션, 문서 변경안까지 한 번에 요청한다.
2. [02-domain-deep-dive-prompts.md](./02-domain-deep-dive-prompts.md)
   - 백엔드, Kafka/Spark 상태 모델, 프런트엔드, 배포 복구성, 데이터 계약, 작업 분할을 영역별로 더 깊게 검토할 때 사용한다.
3. [03-adversarial-review-and-finalization-prompt.md](./03-adversarial-review-and-finalization-prompt.md)
   - Pro가 만든 첫 설계안을 비판적으로 검증하고 최종 문서·ADR·이슈 백로그로 확정할 때 사용한다.

## 권장 사용 순서

### 같은 AskLake 저장소에 접근 가능한 Pro에게 요청할 때

1. `01-master-architecture-modernization-prompt.md` 전체를 전달한다.
2. 첫 답변에서 근거가 약하거나 한 영역이 뭉뚱그려졌으면 `02-domain-deep-dive-prompts.md`의 해당 프롬프트를 추가로 전달한다.
3. 설계안이 충분히 구체화되면 설계안 전문과 함께 `03-adversarial-review-and-finalization-prompt.md`를 전달한다.
4. 최종 결과가 나온 뒤에만 구현 이슈와 브랜치를 만든다.

### 저장소에 접근할 수 없는 Pro에게 요청할 때

최소한 다음 파일을 함께 첨부한다.

- `docs/deployed-code-spaghetti-audit-2026-07-16.md`
- `docs/01-product-planning.md`
- `docs/02-architecture.md`
- `docs/03-api-reference.md`
- `docs/04-development-guide.md`
- `docs/system-guardrails.md`
- `docs/api-contract.md`
- `docs/backend-integration-readiness.md`
- `docs/minio-100gb-spark-harness.md`
- `deploy/docker-compose.prod.yml`

첨부 용량이 부족하면 감사 보고서와 `01-master-architecture-modernization-prompt.md`를 먼저 보내고, Pro가 요구하는 근거 파일을 추가로 제공한다. 파일을 보지 못한 Pro가 세부 계약을 추측하도록 두지 않는다.

## 사용 원칙

- 첫 응답에서 구현을 시작시키지 않는다. 먼저 사실 확인, 목표 구조, 상태 소유권, 전환 순서를 확정한다.
- “마이크로서비스로 바꾸자”, “클린 아키텍처를 쓰자” 같은 일반론만 나오면 불충분한 답변으로 취급한다.
- 현재 동작을 버리는 big-bang rewrite는 기본 선택지로 인정하지 않는다.
- 각 제안은 실제 파일, API, 상태 저장소, 배포 서비스, 테스트에 연결되어야 한다.
- 사실과 추론, 제안, 미확인 사항을 구분하도록 요구한다.
- 목표 구조뿐 아니라 중간 단계에서도 배포 가능하고 롤백 가능한지 확인한다.
- 코드 줄 수 감소보다 데이터 정합성, 재부팅 복구, 상태 권위, 변경 격리를 우선한다.
- 현재 문서의 source-of-truth 우선순위를 그대로 지킨다.

## 기대하는 최종 산출물

프롬프트 묶음을 모두 사용했을 때 최소한 다음 결과가 나와야 한다.

- 현재 아키텍처의 C4 수준 다이어그램
- 상태와 데이터의 source-of-truth 표
- 선택지 2~3개의 비교와 최종 결정
- 목표 모듈·서비스 경계
- Kafka Continuous 상태 머신과 실패 복구 계약
- 프런트엔드 서버 상태·draft 상태·화면 상태 분리안
- clean reboot를 포함한 배포·운영 구조
- 호환 API와 migration adapter 전략
- 단계별 strangler migration 계획
- 파일별 이동·분해 지도
- 테스트, 관측성, 품질 게이트
- 롤백 가능한 이슈 단위 백로그
- `docs/02-architecture.md`를 포함한 문서 변경 목록
- 결정이 필요한 ADR 목록

## 품질 판정 기준

아래 질문 중 하나라도 답이 없으면 후속 프롬프트로 보완한다.

1. Continuous Job의 desired state와 observed state는 각각 누가 소유하는가?
2. Spark report 파일이 유실돼도 최종 상태를 재구성할 수 있는가?
3. EC2 또는 Docker daemon 재부팅 뒤 권한과 runtime이 자동 복구되는가?
4. Python과 Node 중 어느 구현이 각 기능의 최종 권위인가?
5. `etl_service.py`를 어떤 use case 경계로 나누며 transaction 경계는 어디인가?
6. `EtlPages.tsx`와 `useAskLakeData.ts`를 분리해도 wizard draft와 API 계약이 보존되는가?
7. 구버전 Job과 checkpoint가 새 코드에서 안전하게 실행되는가?
8. 각 migration 단계가 독립적으로 배포·관찰·롤백 가능한가?
9. 현재 API와 데이터 계약의 변경 여부가 명시됐는가?
10. 제안이 운영 복잡도를 줄이는지, 단지 파일이나 서비스를 더 늘리는지 검증했는가?
