# Frontend Dashboard Runtime Shell Refactor

## 목적

Issue #403은 Dashboard runtime의 frame, topbar, color palette UI에서 반복되는 wrapper shell을 공통 컴포넌트로 분리하는 작업이다.

## 적용 범위

| 범위 | 변경 파일 | 처리 내용 |
| --- | --- | --- |
| Widget frame shell | `frontend/src/components/ui/widget-shell.tsx` | widget frame의 outer/header/body/overlay slot을 제공하는 `WidgetShell`과 `WidgetShellHeader` 추가 |
| Runtime topbar shell | `frontend/src/components/ui/runtime-topbar.tsx` | title 영역과 actions 영역을 받는 `RuntimeTopbar` 추가 |
| Color palette shell | `frontend/src/components/ui/color-palette-picker.tsx` | color slot, swatch choice, custom panel shell을 받는 `ColorPalettePicker` 추가 |
| Widget frame 적용 | `frontend/src/pages/dashboard/runtime/WidgetFrame.tsx` | 기존 `.asklake-widget-frame` className을 유지한 채 `WidgetShell`로 전환 |
| Topbar 적용 | `frontend/src/pages/dashboard/runtime/DashboardTopBar.tsx` | title/action slot을 `RuntimeTopbar`로 전환 |
| Color palette 적용 | `frontend/src/pages/dashboard/runtime/WidgetConfigPanel.tsx` | 색상 선택 UI wrapper를 `ColorPalettePicker`로 전환 |

## 유지한 범위

- react-grid-layout resize/drag integration은 변경하지 않는다.
- selected/editable/AI working className과 CSS는 유지한다.
- publish/share/rename action 로직은 변경하지 않는다.
- `react-colorful` picker와 color config 계산은 `WidgetConfigPanel`에 유지한다.
- CSS selector 삭제는 하지 않고 기존 className을 공통 컴포넌트에 전달한다.

## 문서 갱신

- `docs/frontend-component-gap-inventory.md`: runtime/widget/color gap을 `부분 해결`로 갱신.
- `docs/frontend-common-component-expansion-candidates.md`: #403 처리 결과와 남은 runtime 상태 cleanup 범위를 기록.
- `docs/frontend-css-cleanup-inventory.md`: #403 CSS 기록을 추가하고 route QA 전 유지할 selector를 정리.
- `docs/frontend-refactor-ui-shell-followup.md`: #403 적용 결과와 후속 후보를 갱신.
