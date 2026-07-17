# EKS Day 17 최종 통합 merge readiness

## 결론

Issue #909 Phase 8의 로컬 merge gate는 `PASS`다. `feat-#909`는 최신
`origin/pair1`을 조상으로 포함하고 있으며 충돌이나 누락된 동기화가 없다. 변경은
Day 17 통합 검증, 동일 Run fixture 선택 회귀 수정, fail-closed receipt 생성과
sanitized evidence에 한정된다.

이 문서는 `pair1` 병합 자체를 승인하지 않는다. Draft PR의 GitHub Actions가 최종
커밋에서 통과하고 리뷰가 끝난 뒤에만 병합한다. production cutover와 `dev` 병합은
Issue #909 범위가 아니다.

## 최종 diff

`origin/pair1...feat-#909`에는 Backend HPA 경합 fixture 선택기와 전용 테스트,
Day 17 최종 receipt generator와 테스트, 운영 가이드·guardrail·실측 evidence만
포함된다. Terraform resource, Helm workload manifest, GitHub Actions workflow,
Frontend와 API/schema는 변경하지 않는다.

동일 Run 경합 수정은 persisted bounded fixture와 현재 Job의 consumer group이
일치해야 한다는 기존 경계를 강화하고, multi-Spark 후보가 경합 fixture를 대신하지
못하게 한다. final receipt 변경은 과거 제출 이력이 없는 독립 캠페인을
`--no-prior`로 명시할 수 있게 하되, 과거 이력을 전달한 경우 partial 이력 누락을
계속 실패 처리한다.

## 검증 결과

현재 최종 커밋에서 다음 검증이 통과했다.

- EKS foundation verifier와 tracked evidence redaction
- EKS web workload Helm lint/render 및 HPA/Collector 계약
- Day 17 scale observer, multi-Spark observer, final receipt 테스트 `26/26`
- Backend HPA fixture 선택 회귀 테스트 `2/2`
- Terraform `1.15.8` container의 `fmt`, `init -backend=false
  -lockfile=readonly`, `validate`, mock test `45/45`
- final private receipt의 판정 `16/16`, sanitizer, mode `0600`
- Git diff whitespace, unmerged entry, conflict marker와 private evidence 추적 감사

Terraform 검증은 AWS backend와 credential을 사용하지 않았고 plan/apply를 실행하지
않았다. Phase 8에서는 live API 부하, Spark Run, Helm upgrade와 AWS/Kubernetes
mutation을 다시 실행하지 않았다.

## 보안과 비용 경계

tracked evidence redaction은 raw Run·Job·SparkApplication·snapshot·dataset,
endpoint, ARN과 credential 형태를 거부한다. Issue #909의 machine receipt와 observer,
load 결과는 저장소 밖 `/private/tmp` 또는 Git ignore 경로의 mode `0600`으로만
유지한다.

최종 diff에는 Terraform·Helm resource 변경이 없으므로 새 상시 AWS 비용을 만드는
경로가 없다. 이미 수행한 live campaign은 cleanup audit에서 Spark Node `0`, HPA
minimum, active Job/SparkApplication과 임시 Kubernetes resource `0`, local load
process `0`으로 복귀했다.

## rollback

병합 전에는 Draft PR을 닫고 `feat-#909`를 병합하지 않으면 된다. 병합 뒤 source
rollback이 필요하면 Issue #909 merge commit을 revert한다. live 환경은 이미 기존
workload steady state로 복귀했으므로 rollback을 위해 NodePool, IAM, RDS, MSK,
durable Run, Iceberg snapshot이나 Catalog materialization을 삭제하지 않는다.

동일 Run fixture 선택기만 되돌릴 때도 테스트를 제거해 과거의 넓은 후보 선택을
허용하지 않는다. 수정 자체를 되돌리는 대신 새 경계 문제를 별도 fix로 해결하는
것을 기본으로 한다.

## PR gate

Draft PR은 `feat-#909 → pair1`로 생성한다. PR은 Issue #909를 연결하며 GitHub
Actions와 리뷰가 끝나기 전 Ready 또는 merge 상태로 전환하지 않는다. CI 결과와
최종 head SHA는 PR과 Issue comment에 남긴다.
