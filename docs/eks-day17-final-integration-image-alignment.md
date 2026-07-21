# EKS Day 17 A/B 최종 이미지 정렬과 preflight

## 결론

Issue #909 Phase 3은 `PASS`다. `feat-#909` commit
`8c014fcc15be3400a4391efb5be340e7936ed61d`에서 공식 `EKS image delivery`
workflow run `29583956114`를 실행해 Frontend, Backend, Airflow, Spark runtime,
Trino의 immutable `linux/amd64` image receipt를 다시 만들었다. receipt의 다섯
role은 ECR config와 실제 EKS workload를 직접 대조했고 모두 일치했다.

이 단계는 HPA 부하나 세 Spark Run을 제출하지 않았다. Phase 4 campaign을 시작할
수 있는 image와 fixture preflight를 닫은 단계다.

## 공식 이미지와 적용 범위

workflow는 2026-07-17에 성공했고 artifact의 `gitRevision`, environment와 platform을
검증했다. canonical private receipt는
`infra/eks/delivery/dev-day17-multi-spark.image-receipt.json`에 mode `0600`으로
보존하며 `.gitignore` 대상이다. account, repository, digest, endpoint와 원본
Kubernetes identity는 이 문서에 기록하지 않는다.

적용 전에는 현재 Helm values를 저장소 밖 mode `0600` 파일로 캡처하고 candidate와
구조 비교했다. 변경은 다음으로 제한됐다.

- runtime ConfigMap의 Spark runtime image
- Web release의 Frontend/Backend image와 runtime revision
- Airflow release의 image
- Trino는 receipt digest가 live와 같아 upgrade하지 않음

세 release 모두 server-side dry-run을 통과한 뒤 component Helm ownership을 유지한
채 적용했다. revision은 runtime ConfigMap `18 → 19`, Airflow `19 → 20`, Web
`53 → 54`다. rollback 기준은 각각 직전 revision이며 raw `kubectl apply`나
Deployment patch는 사용하지 않았다.

## A/B 통합 중 발견한 결함과 수정

처음 공식 `pair1` 이미지를 배포했을 때 multi-Spark preflight는 scale slot 3개와
candidate Job 3개를 정상 인식했다. 그러나 HPA same-run preflight는 같은 Kafka
topic을 사용하는 기본 bounded fixture와 scale candidate 3개를 모두 fixture로
분류해 `candidate_jobs=4`로 실패했다.

HPA 경합의 입력은 기본 consumer group `asklake-eks-mvp-spark-v1` 하나다. 따라서
persisted boundary와 현재 Job의 consumer group이 모두 이 값과 정확히 일치할 때만
후보로 선택하도록 수정했다. `asklake-eks-mvp-spark-scale17-*` group은 같은 topic을
써도 제외한다. 기본 boundary와 현재 Job group이 서로 drift한 경우도 fail-closed로
거부한다.

새 단위 테스트 2개와 multi-Spark runner/result 집중 회귀를 합쳐 `16/16`이
통과했다. 수정 commit으로 이미지를 다시 만든 뒤 live preflight 결과는 다음과 같다.

- Backend fixture contract version `2`, runtime slot `4`
- multi-Spark: scale slot `3`, candidate Job `3`, active Run `0`, Continuous session `4`
- HPA same-run: bounded candidate Job `1`, active fixture Run `0`

HPA preflight가 만든 임시 검증 Job은 runner의 cleanup trap으로 제거됐고, 관련
ServiceAccount, IAM, RBAC와 NodePool은 변경하지 않았다.

## 적용 후 steady와 관찰 결과

Web rollout은 FastAPI `preStop`과 ALB deregistration 계약을 유지했다. drain 종료 후
ALB는 healthy target `4`, draining target `0`, Frontend와 Backend HTTP `200`,
Backend database health 정상으로 돌아왔다.

최종 감사에서는 Pending, terminating, not-ready Pod가 모두 `0`, active Job과 active
SparkApplication이 `0`, Issue #909 Day 17 임시 Job이 `0`이었다. FastAPI HPA는
`2 → 2`, CPU target `60%`, Spark workload와 Spark node는 idle 상태였다. scale과
multi-Spark observer의 단일 read-only snapshot은 저장소 밖 mode `0600` JSONL에
보존했다.

## 다음 gate

Phase 4는 이 receipt와 live revision을 고정한 뒤 read-only API load와 HPA
scale-out/same-run campaign을 실행한다. 실행 중 image, Helm release, HPA 또는
NodePool identity drift가 생기면 중단하고 새 baseline부터 다시 시작한다.
