# AskLake 아키텍처 설계 반박 검증 및 최종화 프롬프트

아래 프롬프트에는 Pro가 만든 아키텍처 개편안 전문을 함께 제공한다. 가능하면 첫 설계안을 작성한 모델과 다른 Pro 세션에도 같은 검증을 요청한다.

---

## 역할

당신은 제안된 AskLake 아키텍처를 승인하거나 거절해야 하는 독립 Architecture Review Board다. 설계안을 친절하게 요약하는 것이 아니라, 현재보다 더 복잡한 스파게티를 만드는 결정을 찾아내고 수정해야 한다.

검토 기준은 다음 파일이다.

- `docs/deployed-code-spaghetti-audit-2026-07-16.md`
- `docs/01-product-planning.md`
- `docs/02-architecture.md`
- `docs/03-api-reference.md`
- `docs/04-development-guide.md`
- `docs/system-guardrails.md`
- `docs/api-contract.md`
- `docs/backend-integration-readiness.md`
- `docs/minio-100gb-spark-harness.md`
- 실제 관련 코드와 `deploy/docker-compose.prod.yml`

## 검증 목표

제안된 설계가 다음 조건을 실제로 만족하는지 공격적으로 검증하라.

1. 기존 God File을 여러 God Service로 바꾼 것뿐이지 않은가?
2. 상태 source-of-truth가 정말 하나씩 정해졌는가?
3. DB, report, checkpoint, S3, Catalog 간 partial failure를 복구할 수 있는가?
4. 새 queue/service/database가 꼭 필요한가?
5. 운영 인력이 감당할 수 없는 구성요소가 추가되지 않았는가?
6. 기존 API, Job, Run, checkpoint와 호환되는가?
7. migration 중 dual-write가 영구 부채가 될 가능성은 없는가?
8. 각 단계가 단독 배포·관찰·rollback 가능한가?
9. clean reboot와 partial restart가 자동 검증되는가?
10. 프런트엔드 상태 소유권이 명확해졌는가?
11. 테스트가 구현 세부가 아니라 계약과 상태 전이를 검증하는가?
12. 문서가 구현보다 앞서 거짓 source of truth가 되지 않는가?

## 필수 공격 시나리오

설계안을 다음 상황에 적용해 실패 지점을 찾아라.

- 사용자가 start를 두 번 빠르게 요청
- backend가 DB commit 직후 종료
- Spark submission은 성공했지만 response 유실
- Spark worker만 재시작
- EC2 전체 재부팅
- report 파일이 없거나 손상
- output은 존재하지만 manifest 저장 실패
- Catalog materialization 중 DB deadlock
- Dashboard publication만 실패
- stale worker가 새 worker와 동시에 checkpoint 사용
- Kafka partition 수 변경
- 구버전 checkpoint로 새 rule 실행
- frontend 두 탭이 같은 Job을 조작
- polling 응답 순서가 뒤바뀜
- migration 중 구버전 backend로 rollback

각 시나리오마다 다음 표를 작성하라.

| 시나리오 | 예상 상태 | 정합성 보장 | 자동 복구 | 사용자 표시 | 운영자 조치 | 설계 결함 |
|---|---|---|---|---|---|---|

## 필수 산출물

### 1. 승인 판정

다음 중 하나로 시작하라.

- 승인
- 조건부 승인
- 재설계 필요

판정 이유를 10줄 이내로 작성하라.

### 2. 설계 결함 목록

심각도 `P0/P1/P2/P3`로 정리하고 각 항목에 다음을 포함하라.

- 결함
- 발생 조건
- 실제 영향
- 근거
- 수정안
- 수정하지 않을 때의 결과

### 3. 불필요한 복잡도 제거

제안된 새 component, service, queue, table, abstraction 중 제거하거나 합칠 대상을 표시하라. 유지해야 한다면 그 이유와 운영 비용을 설명하라.

### 4. 상태 모델 재검증

canonical owner, writer, recovery source가 충돌하는 항목을 찾아 수정된 ownership matrix를 제시하라.

### 5. Migration 위험 검증

각 단계의 blast radius, rollback 가능성, data migration 위험, compatibility 종료 조건을 검토하라. 단독 배포할 수 없는 단계는 더 작게 나눠라.

### 6. 최종 권고 아키텍처

첫 설계안을 그대로 반복하지 말고 검증 결과를 반영한 최종 diagram, module boundary, state machine, deployment flow를 제시하라.

### 7. 문서화 가능한 최종 결정

다음을 출력하라.

- ADR 제목과 상태
- `docs/02-architecture.md` 최종 개정 목차
- API 문서 변경 목록
- 운영 guardrail 변경 목록
- 구현 전 반드시 확정할 open question

### 8. Go/No-Go 체크리스트

실제 구현을 시작해도 되는 조건을 체크박스로 작성하라. P0 미해결 상태에서는 Go를 허용하지 마라.

## 최종 품질 규칙

- 설계자의 의도를 선의로 추정하지 말고 failure evidence로 검증하라.
- “일반적으로 괜찮다”는 표현을 사용하지 마라.
- 보장할 수 없는 exactly-once, zero-downtime, automatic recovery 표현을 제거하라.
- 운영자가 수동으로 DB나 volume을 수정해야 하는 정상 경로를 승인하지 마라.
- 문제를 다른 계층으로 이동시킨 것을 해결로 인정하지 마라.
- 최종 답변은 구현 팀이 바로 문서와 issue로 전환할 수 있을 정도로 구체적이어야 한다.

이제 제공된 아키텍처 개편안을 반박 검증하고, 수정된 최종안을 작성하라.
