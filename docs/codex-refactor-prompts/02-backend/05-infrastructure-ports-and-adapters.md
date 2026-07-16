# 05 — Spark/Kafka/Airflow/Node/Report 인프라 Port·Adapter 추출 Codex 프롬프트

## 목표

`etl_service.py`와 application 코드에서 외부 I/O 세부를 걷어내고, 테스트 가능한 명시적 port/adapter로 격리한다. 이번 단계의 우선 목표는 동작 보존이다.

## Codex에 전달할 프롬프트

runtime state contract와 characterization test를 읽고, 현재 실제 호출 방향을 기준으로 infrastructure boundary를 추출하라.

### 대상 I/O

- Spark REST submission/status/cancel
- Kafka admin/consumer group/lag
- Airflow trigger/status
- Node ESM subprocess bridge
- runtime report file read/write/list
- checkpoint/manifest/object storage 접근
- Catalog/Trino/Dashboard 외부 호출 중 ETL service에 직접 있는 부분
- 환경변수와 Docker path 해석

### 구현 작업

1. 현재 호출 목록과 caller를 표로 만든다.
2. use case가 필요한 최소 메서드만 가진 Protocol/ABC/interface를 정의한다.
3. 기존 코드를 adapter 구현으로 이동한다. 예시 이름은 실제 convention에 맞춘다.
   - `SparkGateway`
   - `KafkaRuntimeGateway`
   - `AirflowGateway`
   - `NodeBridge`
   - `RuntimeReportStore`
   - `CheckpointStore`
   - `ObjectManifestStore`
4. timeout, retry, cancellation, structured error를 adapter 경계에서 통일한다.
5. application layer에는 adapter의 low-level response 대신 domain result를 반환한다.
6. dependency wiring은 기존 FastAPI lifecycle/dependency 패턴을 활용한다. global singleton을 새로 늘리지 않는다.
7. 기존 함수 signature를 바로 깨지 말고 compatibility wrapper를 유지한다.
8. fake/spy adapter를 만들고 characterization test가 실제 subprocess/network 없이 실행되게 한다.
9. `etl_service.py`에서 직접 사용하던 `subprocess`, raw file open, raw HTTP call 수를 전/후로 측정한다.

### 금지 사항

- port를 수십 개의 1-method interface로 무의미하게 쪼개지 마라.
- 실제로 독립 배포하지 않을 코드를 microservice로 만들지 마라.
- retry를 여러 계층에 중복 구현하지 마라.
- adapter 내부 오류를 문자열 하나로 삼키지 마라.

### 완료 기준

- application/use case 테스트에서 Spark/Kafka/Node/Docker가 필요 없다.
- 외부 I/O의 timeout과 error mapping이 한 경계에 있다.
- `etl_service.py`의 직접 인프라 접근이 현저히 줄었다.
- 기존 API와 runtime behavior가 characterization test 기준으로 유지된다.
- 다음 Continuous command extraction이 adapter만 의존해 가능하다.
