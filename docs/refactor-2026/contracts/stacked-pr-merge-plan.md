# 10단계 Stacked PR 순차 머지 계약

이 계약은 현재 refactor stack을 한 번에 하나씩 `dev`로 머지하기 위한 정적 계획이다. PR 생성과 검증 범위를 다루며 자동 merge, branch 삭제 또는 production 배포 권한을 부여하지 않는다.

## Source of truth

- 순서·issue·PR·branch·base·선행 관계: `docs/refactor-2026/final/stacked-pr-merge-plan.json`
- 구조 검증: `scripts/refactor_audit/stacked_pr_merge_plan.py`
- release 차단 상태: `docs/refactor-2026/final/release-gates.json`

모든 entry는 base `dev`, branch `refactor-#<issue>`를 사용한다. 첫 entry를 제외한 각 PR은 바로 앞 PR 번호를 `dependsOnPullRequest`로 가진다. 최종 PR을 생성하는 짧은 구간에만 마지막 entry의 `pullRequest=null`, `declaredReviewState=pending-pr`를 허용한다.

## 사람 merge 절차

1. manifest의 가장 앞 open PR 하나만 review-ready로 전환한다.
2. required CI와 review 승인을 확인한 뒤 그 PR만 `dev`로 머지한다.
3. `dev`를 새로 fetch하고 다음 PR의 base diff, conflict와 전체 check를 다시 확인한다.
4. 예상 밖 파일, failed/pending check 또는 dependency drift가 있으면 즉시 중단한다.
5. 10번째 PR까지 같은 절차를 반복한다.

merge 도중 deploy를 수행하지 않는다. 모든 PR merge 완료는 production 실행 승인이 아니며 isolated nightly, clean reboot, backup/restore와 release owner 승인이 끝날 때까지 execution gate는 blocked 상태를 유지한다.

## Rollback

머지 전에는 해당 PR을 수정하거나 닫아 되돌린다. 머지 후에는 shared `dev` history를 강제로 되감지 않고 별도 revert PR을 같은 review/CI 절차로 처리한다. runtime data migration은 이 stack에서 수행하지 않는다.
