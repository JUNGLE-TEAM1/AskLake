# Legacy·Fallback 제거 증거 계약

이 계약은 production에서 도달 가능한 compatibility path를 즉시 삭제하거나 활성화하지 않고, 제거 판단에 필요한 관찰·증거·승인을 fail closed로 관리한다.

## Source of truth

- 경로의 activation, owner, source marker, telemetry와 제거 조건: `docs/refactor-2026/legacy-path-register.json`
- 제거 준비 상태와 실제 관찰 근거: `docs/refactor-2026/legacy-removal-evidence.json`
- 정적 판정: `scripts/refactor_audit/legacy_removal_evidence.py`

evidence manifest의 path ID와 owner는 register의 `reachability=production` 10개와 정확히 일치해야 한다. development/local-only 경로를 운영 제거 증거처럼 등록하지 않는다.

## 상태 전이

관찰 상태는 `not_started → collecting → passed|failed` 순서다. `passed`는 최소 30일 window, `observedCalls=0`, log query/dashboard export/release record 중 하나 이상의 참조가 있어야 한다. 관찰이 통과해도 별도 reviewer와 release reference가 있는 `approved` 전에는 제거 가능 경로가 아니다.

현재 10개 경로는 모두 `not_started`와 `not_requested`이며 제거 가능 경로는 0개다. 이는 0-call을 주장하는 것이 아니라 production 증거가 아직 첨부되지 않았다는 뜻이다.

## 실패·rollback

누락·중복·unknown path, owner drift, 30일 미만 window, non-zero call을 `passed`로 표기한 상태, 근거·승인 누락은 CI를 실패시킨다. validator의 `status=pass`는 문서 구조가 유효하다는 뜻이며 compatibility 제거 승인이 아니다.

이 PR은 runtime source, feature flag, API, DB, UI와 배포 topology를 바꾸지 않는다. rollback은 manifest·validator·CI 연결만 되돌리며 기존 compatibility source와 persisted data에는 영향이 없다.
