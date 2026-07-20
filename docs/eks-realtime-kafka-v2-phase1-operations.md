# EKS 실시간 Kafka V2 운영 배포 Phase 1 증적

이 문서는 Issue #1084 Phase 1의 이미지·정적 계약 준비 결과다. Phase 1에서는 로컬 `linux/amd64` image build와 정적 검증을 수행했지만, 승인된 ECR 대상이 없으므로 외부 registry push와 EKS apply는 수행하지 않았다.

## 판정

현재 판정은 **LOCAL-BUILD-PASS / REGISTRY-PUSH-BLOCKED / EKS-NO-GO**다.

- ClickHouse V2, Kafka Connect V2, Backend image를 `linux/amd64`로 로컬 build했다.
- Kafka Connect image 안의 AWS MSK IAM auth 2.3.6 JAR과 ClickHouse Sink 1.4.0을 확인했다.
- MSK IAM JAR은 worker classpath에만 있고 Connect plugin path와 충돌하지 않는다.
- Backend container import smoke와 V2 machine/Helm/storage/Kafka IAM contract가 통과했다.
- 실제 ECR repository/registry와 push 권한이 명시되지 않아 local digest를 운영 image receipt로 승격하지 않았다.
- Phase 0의 cluster target 미지정 상태가 남아 있어 EKS read-only preflight와 apply는 계속 차단한다.

기계 판독 결과는 [`deploy/eks-realtime-kafka-v2-phase1-receipt.json`](../deploy/eks-realtime-kafka-v2-phase1-receipt.json)에 기록했다. 이 receipt의 local manifest digest는 재현용 증거이며, ECR digest가 아니다.

## 이미지 결과

| 구성요소 | 로컬 tag | 결과 |
| --- | --- | --- |
| ClickHouse V2 | `asklake/clickhouse-v2:phase1-local` | `linux/amd64` build pass |
| Kafka Connect V2 | `asklake/kafka-connect-v2:phase1-local` | build pass, IAM JAR/classpath smoke pass |
| Backend | `asklake/backend:phase1-local` | build pass, Python import smoke pass |

실행한 확인:

```bash
docker buildx build --platform linux/amd64 --load -t asklake/clickhouse-v2:phase1-local ./deploy/clickhouse-v2
docker buildx build --platform linux/amd64 --load -t asklake/kafka-connect-v2:phase1-local ./deploy/kafka-connect
docker buildx build --platform linux/amd64 --load -t asklake/backend:phase1-local ./backend
docker run --rm --platform linux/amd64 --entrypoint /bin/sh asklake/kafka-connect-v2:phase1-local -c 'test -r /usr/share/java/cp-base-new/aws-msk-iam-auth-2.3.6-all.jar && test ! -e /usr/share/java/aws-msk-iam-auth-2.3.6-all.jar'
docker run --rm --platform linux/amd64 --entrypoint /bin/sh asklake/backend:phase1-local -c 'python -c "import app"'
```

## 통과한 정적 gate

- `verify_eks_realtime_kafka_v2_mvp.py`
- `verify-eks-realtime-v2-storage.py`
- `verify-eks-realtime-v2-workload.sh`
- Helm lint 및 V2 image receipt/negative tests
- Kafka exact topic/group/IAM contract tests
- live evidence negative tests
- `scripts/verify-eks-realtime-data-plane.sh` 전체 wrapper (Terraform fmt/validate, Helm, secret/TLS와 negative gate 포함)
- shell syntax와 `git diff --check`

## 막힌 gate와 필요한 입력

1. 승인된 ECR registry/repository 이름과 `linux/amd64` push 권한
2. push 후 생성되는 ClickHouse·Kafka Connect·Backend immutable ECR digest
3. `ASKLAKE_EKS_CLUSTER_NAME`과 해당 endpoint에 일치하는 `kubectl` context
4. 실제 cluster/namespace/MSK bootstrap/ClickHouse endpoint를 가진 private values
5. 배포 window와 rollback owner

ECR push는 digest receipt에 기록할 대상과 권한이 확정된 뒤에만 실행한다. `latest`, local tag, 추정한 account/ARN을 운영 manifest에 사용하지 않는다.

## 다음 Phase 1 종료 기준

Phase 1은 다음을 모두 만족할 때 종료한다.

- ECR에 세 image가 push되고 각 digest가 receipt와 일치한다.
- receipt verifier와 Helm render가 실제 private values에서 통과한다.
- MSK IAM JAR checksum, ClickHouse Sink 1.4.0, platform `linux/amd64`가 receipt에 고정된다.
- Secret 원문이 image, values, receipt, rendered manifest에 포함되지 않는다.
- Phase 0 read-only EKS preflight가 통과한다.

그 전까지 `phase1Ready=false`이며 Phase 2 data-plane 배포로 진행하지 않는다.
