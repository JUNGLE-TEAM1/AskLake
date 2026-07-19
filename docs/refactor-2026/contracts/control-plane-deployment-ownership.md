# EKS·EC2 Continuous control-plane 단일-owner 계약

## 목적

Production은 EKS의 웹·유한 배치 workload와 EC2 Compose의 전용 Continuous worker를 함께 사용한다. 두 deployment cell이 같은 장기 reconciliation loop를 동시에 소유한다고 선언하면 동일 Job에 중복 명령이 전달될 수 있으므로, 배포 전에 machine-readable topology에서 owner 수를 검증한다.

이 계약은 현재 실행 위치를 옮기거나 FastAPI background task를 켜고 끄지 않는다. 현재 배포 기준을 명시하고 이후 manifest 변경에서 중복 claim을 차단하는 정적 guard다.

## Canonical manifest

`deploy/control-plane-ownership.json`이 production deployment cell과 Continuous owner 선언의 source of truth다.

| Control plane | Runtime entrypoint evidence | 현재 owner |
| --- | --- | --- |
| Kafka Continuous runtime reconciliation | `backend/app/continuous_worker.py::sync_active_kafka_continuous_runtimes` | `ec2-continuous-worker` |
| Continuous SQL runtime reconciliation | `backend/app/continuous_worker.py::sync_active_continuous_sql_jobs` | `ec2-continuous-worker` |

`eks-web-finite-batch`는 현재 배포 topology에 존재하지만 위 두 장기 control plane을 claim하지 않는다. EKS/EC2의 실제 rollout 또는 역할 이동은 manifest 한 줄만 바꾸는 작업이 아니며, 대상 runtime 설정과 배포 증거를 같은 PR에 포함해야 한다.

EKS Continuous gateway와 worker package는 repository에 준비돼 있어도 현재 owner를 자동으로 변경하지 않는다. `asklake-workloads`의 disabled `realtimeV1` component는 `asklake-backend` service account의 SparkApplication RBAC를 재사용하며, apply 전에 EC2 Kafka scope를 fence하고 canonical ownership manifest를 같은 release에서 바꿔야 한다. approval, previous-owner fence와 generation이 없으면 Helm render가 실패한다.

## 실패 조건

`scripts/refactor_audit/control_plane_ownership.py`는 다음을 fail closed 한다.

- required control plane의 active owner가 0개 또는 2개 이상인 경우
- inactive workload가 control plane을 claim한 경우
- 등록되지 않은 workload platform 또는 control-plane ID를 사용한 경우
- workload ID 또는 deployment cell이 중복된 경우
- EKS/EC2 중 required active platform이 manifest에서 사라진 경우
- repository evidence의 파일 또는 marker가 실제 source에서 사라진 경우
- contract owner, review date 또는 evidence가 누락된 경우

정적 검증은 실행 중인 cluster 상태를 발견하지 않는다. Draft 해제와 production rollout 전에는 EKS workload spec, EC2 Compose process와 실제 replica/task 목록을 운영자가 대조해야 한다.

## 검증

```bash
python3 -m unittest scripts.refactor_audit.test_control_plane_ownership
python3 scripts/refactor_audit/control_plane_ownership.py

cd backend
npm run verify:control-plane-ownership
```

`Refactor Quality Gates / structural-ratchet`가 unit과 현재 production manifest를 매 PR에서 실행한다.

## 변경 금지 범위

- `backend/app/main.py`의 lifespan과 loop 등록 순서
- Continuous command, worker fencing, report/checkpoint/manifest, Catalog·Dashboard publication 의미
- Compose environment, EKS workload, replica 수, traffic과 실제 프로세스
- API, DB schema, frontend route·DOM·CSS와 legacy/mock/fallback 활성 상태

## Rollback

validator, manifest, CI entry와 이 문서를 함께 되돌린다. runtime code와 persisted data를 변경하지 않았으므로 process restart, DB migration 또는 data rewrite는 필요 없다. 다만 owner topology 자체를 바꾸는 후속 배포가 이미 있었다면 이 정적 계약만 되돌리지 말고 실제 workload ownership을 먼저 복구해야 한다.
