# Pull Request

## 1. PR 요약

이번 PR은 <!-- 무엇을 가능하게 하거나 어떤 문제를 해결하는지 1~2문장으로 적습니다. -->

- 연결된 Issue: <!-- 예: Closes #123 / 연결된 issue 없음 -->
- No Linked Issue Exception: <!-- no-issue 예외가 승인된 경우에만 approved, 아니면 비움 -->
- Branch:
- Branch workspace:
- 상태: <!-- 리뷰 요청 / Draft / follow-up 필요 -->

## 2. 변경 내용

<!-- 리뷰어가 diff를 읽기 전에 목적, 변경 전 문제, 바꾼 것, 제외한 것을 자연스럽게 이해할 수 있도록 문단으로 씁니다. -->

기존에는 <!-- 변경 전 문제나 불편한 점을 씁니다. -->

이번 변경은 <!-- 이번 PR의 핵심 변경을 씁니다. -->

구체적으로는 <!-- 주요 변경 영역과 왜 필요한지 씁니다. -->

이번 PR에서 하지 않은 일도 분명히 남깁니다. <!-- 제외 범위나 후속 작업을 씁니다. -->

## 3. 검증

<!-- 실행한 검증과 결과를 문장으로 먼저 설명하고, 명령은 아래에 그대로 적습니다. -->

이번 PR은 <!-- 어떤 기준으로 확인했는지 씁니다. -->

-

실행하지 못한 검증이 있다면 이유를 적습니다.

-

## 4. 영향 범위

<!-- 영향이 없는 항목은 "없음"이라고 짧게 적습니다. -->

이 PR은 <!-- UI/API/schema/data/security/문서/운영 중 어디에 영향을 주는지 씁니다. -->

- UI 영향:
- API/schema 영향:
- data/migration 영향:
- security/privacy 영향:
- 문서/운영 영향:
- Source of Truth 문서 영향:

secret, credential, license 변경 여부:

-

## 5. 리뷰어에게 부탁할 부분

<!-- 리뷰어가 시간을 아낄 수 있도록 먼저 볼 파일/흐름과 위험한 지점을 적습니다. -->

먼저 <!-- 첫 번째로 봐야 할 파일, 화면, API, 흐름을 씁니다. -->

그 다음 <!-- 두 번째로 확인할 포인트를 씁니다. -->

마지막으로 <!-- edge case, 회귀 위험, 애매한 결정을 씁니다. -->

## 6. 남은 일 / 제외한 일

이번 PR에서는 <!-- 의도적으로 제외한 범위와 후속 작업을 씁니다. -->

-

후속 Issue/PR:

-

## 7. Merge 전 확인

- CI/check가 통과했는지 확인합니다.
- frontend 변경이 있으면 `cd frontend && npm run build` 통과 또는 deferral reason을 확인합니다.
- linked issue와 closing keyword가 맞는지 확인합니다.
- merge 후 issue close와 Project 상태가 맞는지 확인합니다.
- merge/finalize/cleanup은 사람 확인 후 진행합니다.
