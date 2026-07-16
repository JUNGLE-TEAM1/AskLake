# EKS 16일차 Phase 6 blocker 보완 기록

## 결과

세 blocker 중 runtime ConfigMap ownership과 Spark 실행 증거는 해결했다. AI runtime은 `direct`로 선택하고 계약·실패 경로 검증까지 완료했지만, 실제 OpenAI key가 Secrets Manager source에 없어 full-service Secret 적용과 Backend rollout, 최종 promotion은 의도적으로 실행하지 않았다.

## Runtime ConfigMap ownership

`asklake-runtime`은 새 `asklake-runtime-config` Helm release가 단독 소유한다. 적용 전 live data와 새 chart render를 canonical JSON으로 비교했고 hash가 정확히 같은 상태에서 Helm ownership만 인수했다. 적용 후 ConfigMap data, Web/Airflow/Trino release와 여섯 application Deployment의 상태는 변하지 않았다.

앞으로 공용 non-secret runtime 값은 이 release를 통해서만 변경한다. workload chart나 별도 `kubectl apply` field manager가 같은 ConfigMap을 인수하면 검증이 실패한다.

## AI direct 선택과 남은 입력

MVP AI runtime은 `direct`다. full-service Backend profile은 기존 bounded 12개 key에 `OPENAI_API_KEY`를 추가한 exact 13-key 계약이다. 정적 contract, unresolved decision 실패 경로와 direct profile 검증은 통과했다.

현재 AWS source에는 실제 OpenAI key가 없다. 따라서 빈 문자열, 임의 token 또는 placeholder를 만들지 않았고 live ExternalSecret과 Backend Deployment도 변경하지 않았다. 실제 key가 준비되면 source exact set, staged target hash, canonical target handover, FastAPI 2 replica rollout과 ALB/RDS/Trino/AI health를 순서대로 검증해야 한다.

## Spark 증거 복구와 보존

기존 완료 SparkApplication이 사라진 원인은 backend manifest의 기본 `timeToLiveSeconds: 3600`에 따른 정상 자동 삭제였다. 새 private fixture 100건을 생산한 뒤 bounded E2E를 한 번 새로 실행했다. SparkApplication은 driver와 executor를 생성해 완료됐고 RDS Run, Iceberg snapshot, Trino exact 100행과 Catalog materialization이 일치했다.

첫 재실행 시도에서 transient driver Pod collision이 발생해 실패 object와 Pod를 정확히 삭제했다. 두 번째 실행은 정상 완료됐다. 실행기에는 raw DB polling 대신 공식 Job 조회를 통한 Airflow reconciliation을 추가해 완료 DAG가 `queued`로 남지 않게 했다.

성공 SparkApplication은 current image와 persisted identity를 대조한 뒤 evidence label을 붙이고 TTL을 7일로 연장했다. `--verify-only`는 20개 검사, `--verify-retry`는 25개 검사를 통과했고 두 실행 모두 exact 100행, materialization 1개와 temporary residue 0을 확인했다. 실제 식별자, endpoint, ARN, digest와 credential은 이 문서에 기록하지 않는다.

## 최종 상태

- bounded handoff audit: ready, blocker 0
- runtime ConfigMap selection/ownership/image: ready
- new bounded E2E and idempotent retry: passed
- AI decision: direct
- AI source/target delivery: blocked by missing real key
- Backend full-service rollout and promotion: not run

EC2 Continuous와 기존 rollback 원본은 변경하지 않았다. 남은 작업은 실제 key 제공 권한이 있는 담당자가 Secrets Manager source를 채운 뒤 Secret 전달, Backend rollout과 final ready/promotion을 실행하는 것이다.
