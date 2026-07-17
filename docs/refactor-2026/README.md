# AskLake 단계적 리팩토링 원장

이 디렉터리는 2026-07-16 배포 코드 감사 이후 진행하는 15개 순차 PR의 기준선과 handoff를 보관한다. 감사 커밋은 비교점일 뿐 checkout 대상이 아니며, 실제 작업은 각 PR 생성 시점의 최신 `dev`를 기준으로 한다.

## 읽는 순서

1. [progress-ledger.md](./progress-ledger.md): 완료·현재·남은 작업의 단일 원장
2. [current-head-and-drift.md](./current-head-and-drift.md): 감사 커밋과 최신 `dev`의 차이
3. [risk-register.md](./risk-register.md): P0/P1 위험과 해소 단계
4. [decision-log.md](./decision-log.md): 범위·호환성·머지 방식 결정
5. [baseline/current-code-metrics.md](./baseline/current-code-metrics.md): 정량 기준선
6. [baseline/current-contracts.md](./baseline/current-contracts.md): API·DB·runtime·frontend 계약 기준선
7. [baseline/test-command-map.md](./baseline/test-command-map.md): 검증 명령과 실행 조건
8. [baseline/pre-existing-failures.md](./baseline/pre-existing-failures.md): 변경 전 실패 목록
9. [operations/spark-runtime-reboot-recovery.md](./operations/spark-runtime-reboot-recovery.md): Spark 경로 재부팅 복구·검증·rollback
10. [contracts/runtime-state-ownership.md](./contracts/runtime-state-ownership.md): Continuous desired/observed/public 상태와 오류·fencing 계약
11. [testing/characterization-matrix.md](./testing/characterization-matrix.md): 분해 전 보호해야 할 backend/frontend 동작과 검증 위치
12. [contracts/frontend-state-etl-wizard.md](./contracts/frontend-state-etl-wizard.md): frontend 요청·draft·route·mutation 소유권과 ETL Wizard 모듈 경계
13. [final-audit.md](./final-audit.md): 정량 재감사, 잔여 위험, END_STATE 증거와 guarded Go/No-Go
14. [operations/staged-rollout-and-rollback.md](./operations/staged-rollout-and-rollback.md): production 전 수동 gate, canary, 관찰, rollback template
15. [contracts/deployed-ui-no-reactivation.md](./contracts/deployed-ui-no-reactivation.md): 배포 UI 무변경, compatibility façade 비활성, production mock/legacy 차단 계약
16. [contracts/etl-job-query-boundary.md](./contracts/etl-job-query-boundary.md): Job list/detail runtime refresh, hydrate, permission과 facet application 경계
17. [contracts/etl-job-command-boundary.md](./contracts/etl-job-command-boundary.md): Job delete 권한, active workload 보호, 종속 정리와 commit/rollback 경계
18. [contracts/etl-job-write-boundary.md](./contracts/etl-job-write-boundary.md): 일반 Pipeline create/update validation, identity, mapping, permission과 repository write 경계
19. [contracts/airflow-execution-publication-boundary.md](./contracts/airflow-execution-publication-boundary.md): Snapshot Airflow Spark 실행 lease·finalize와 Catalog reconciliation transaction 경계
20. [contracts/source-connector-authority-boundary.md](./contracts/source-connector-authority-boundary.md): Source connector Python use case와 Node runtime adapter 권위 경계
21. [contracts/control-plane-deployment-ownership.md](./contracts/control-plane-deployment-ownership.md): EKS·EC2 Continuous deployment cell의 단일-owner 선언과 정적 검증 계약

## 기준선 재생성

```bash
python3 scripts/refactor_audit/collect_baseline.py

python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt
PYTHONPATH=backend backend/.venv/bin/python scripts/refactor_audit/export_openapi.py
```

`backend/requirements.txt`의 `mcp==1.28.1`은 Python 3.10 이상이 필요하다. macOS 기본 Python 3.9를 사용하는 환경에서는 Python 3.10+로 가상환경을 만들어야 한다.

생성되는 JSON은 deterministic ordering을 사용하고 timestamp, hostname, credential을 포함하지 않는다.

최종 재감사와 release plan은 다음처럼 재생한다. 두 번째 명령은 plan 구조만 확인한다. 실제 production 실행 gate는 세 수동 증거가 모두 `passed`가 되기 전 의도적으로 exit 2를 반환한다.

```bash
cd backend
npm run verify:refactor-final-audit
npm run verify:refactor-release-plan
npm run verify:refactor-release-execution
```

## 머지 규칙

- 모든 PR의 base는 `dev`다.
- 현재 배치는 앞 PR의 branch HEAD에서 다음 branch를 만드는 stacked 방식이다.
- 머지 순서는 원장의 `선행 PR`을 따른다.
- 이전 PR이 머지된 뒤 다음 PR의 diff와 CI를 다시 확인한다.
- 한 배치에서 3개 PR을 연 뒤 사용자 확인 전 다음 배치를 시작하지 않는다.
