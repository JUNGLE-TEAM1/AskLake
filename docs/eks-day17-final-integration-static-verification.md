# EKS Day 17 A/B 최종 통합 정적 검증

## 결론

Issue #909 Phase 1은 `pair1` merge commit
`d540cf58078725a3ec9cf1d051de9c4c2d8d18ec`에 Phase 0 기록 commit
`19936003`을 더한 branch에서 실행했고 최종 판정은 `PASS`다. A의 NodePool과
관찰기, B의 Helm workload와 FastAPI HPA·multi-Spark runner, Backend 실행 경계,
Terraform foundation 및 evidence sanitizer에서 source regression은 발견되지
않았다.

이 판정은 로컬 정적 검증 결과다. Phase 0에서 확인한 live Airflow·Trino
placement와 canonical image receipt blocker를 해제하지 않으며, API load 또는
Spark Run을 실행했다는 뜻도 아니다.

## A NodePool과 관찰기

다음 검증이 모두 통과했다.

- Auto Mode General/Spark NodePool Helm schema, disabled default와 음성 입력
- Day 17 격리 NodePool smoke chart와 selector·toleration 계약
- baseline/sample/final evidence의 fail-closed 동작과 cleanup 계약
- HPA, Deployment, Pod, Metrics, managed instance, Event와 load status sanitizer
- Foundation의 RBAC, image receipt input, runtime ConfigMap/profile, ALB, web,
  Metrics Server와 tracked evidence 검증

scale observer 단위 테스트는 `7/7` 통과했다. Foundation verifier는 로컬
Terraform CLI가 없어 처음에는 Terraform 부분만 명시적으로 skip했고, 같은
검증을 공식 Docker 명령으로 다시 실행해 보완했다.

## B workload와 통합 receipt

다음 검증이 모두 통과했다.

- `asklake-workloads` Helm lint/render 및 Airflow-only ownership
- Airflow·Trino General selector와 Spark driver/executor selector·toleration
- `asklake-web` FastAPI HPA `autoscaling/v2`, `2..6`, CPU `60%`, scale behavior,
  Collector singleton과 HPA 비활성 복귀
- runtime Secret schema, dev mapping과 Trino password DB
- multi-Spark observer의 identity hashing, 3-run 격리, node scale 및 sanitizer
- A/B 최종 receipt의 두 timeline 연결, 실패 경로와 raw identity 차단
- tracked evidence redaction

multi-Spark observer 테스트는 `11/11`, 최종 receipt 테스트는 `5/5`, runtime
Secret verifier는 `25`개 시나리오, Trino password DB는 `6`개 시나리오를
통과했다.

## Backend 집중 회귀

Kubernetes Spark client `14/14`, Kafka fixture boundary `13/13`이 통과했다.
프로젝트 `.venv`의 Python 3.13로 아래 범위를 실행한 결과 `90`개가 통과하고
선택형 PostgreSQL 동시성 테스트 `1`개만 설정값 부재로 skip됐다.

- Trino result storage AWS boundary
- AWS/MinIO object storage mode
- ETL delete, lease, same-run 경합과 세 fixture slot
- Dashboard live result 회귀
- EKS Continuous external-EC2 및 Kubernetes Spark runtime 경계
- Day 17 multi-Spark 결과 정합성과 runner fail-closed 계약
- Airflow Catalog wiring

처음 시스템 Python 3.14로 실행했을 때 `pydantic`, `duckdb`, `sqlalchemy`,
`fastapi` import가 실패했다. 이는 테스트 또는 source 실패가 아니라 프로젝트
의존성이 없는 interpreter를 선택한 실행 오류였다. 같은 명령을
`backend/.venv/bin/python`으로 재실행해 전부 통과했다. 이후 로컬 검증은 CI의
Python 3.13 또는 project `.venv`를 사용한다.

## Terraform

로컬에 Terraform CLI가 없어 문서에 고정된 `hashicorp/terraform:1.15.8`
container에서 `fmt -check -recursive`, `init -backend=false`, `validate`,
`terraform test`를 실행했다. configuration validation과 foundation mock test
`45/45`가 통과했다. 이 명령은 backend를 비활성화하며 AWS resource를 만들거나
Terraform state를 변경하지 않는다.

## 다음 gate

Phase 2에서는 병합된 chart와 live Helm values를 server-side dry-run으로
대조한다. Airflow와 Trino에 General selector를 적용하기 전 release ownership,
현재 private values, immutable images와 예상 delta가 selector 추가뿐인지
확인해야 한다. canonical Day 17 image receipt 복구는 Phase 3 gate로 유지한다.
