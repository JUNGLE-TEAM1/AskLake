# ClickHouse 실시간 GOLD EKS 로컬 검증 기록

## 감사 기준

- Issue: `#1061`
- 작업 브랜치: `feat-#1061`
- 최종 `origin/pair1`: `206f9202171220319b3f6dff3a7b506cbdd60a2f`
- 최종 `origin/dev`: `c7ea77e48c940c04812e07d166af2f0401f59009`
- 작업 branch의 pair1 merge-base: `206f9202171220319b3f6dff3a7b506cbdd60a2f`
- 감사일: 2026-07-19

초기 기준 `392f8477` 이후 pair1에 추가된 Issue #1044 EKS Realtime V1 패키지와 PR #1063 Trino fixed-5 복구 강화는 feature branch를 두 차례 fast-forward해 보존했다. dev의 후속 Issue #1050 synthetic commerce generator/fixture는 #1061 최소 범위가 아니어서 제외했다. 공유 AWS/EKS apply, EC2 중단과 실제 owner 전환은 수행하지 않았다.

## 기능·회귀 검증

| 검증 | 결과 |
| --- | --- |
| Backend ClickHouse/Catalog/Dashboard/whitespace/worker scope 집중 pytest | 57 passed |
| `npm run verify:continuous-sql-contract` | 23 passed |
| `npm run verify:clickhouse-realtime-v2-release` | 60 passed |
| `npm run verify:realtime-stack` | 101 passed |
| `npm run verify:control-plane-ownership` | pass |
| `ASKLAKE_QUALITY_GATE_BASE=origin/pair1 npm run verify:quality-gates` | pass |
| Frontend Continuous SQL UI | 4 passed |
| Frontend Dashboard Realtime V2 묶음 | 24 passed |
| Frontend production build | pass; 기존 large-chunk warning만 존재 |

집중 테스트는 Kafka+static relation 감지, JOIN validation과 unique-key evidence, V2 생성/시작, 첫 publication 뒤 Catalog 공개, Dashboard `FINAL` projection, whitespace fact, bounded static dimension load와 오류 경로를 포함한다.

## EKS 정적·부정 검증

다음을 실행했다.

```bash
bash scripts/verify-eks-realtime-data-plane.sh
bash scripts/verify-eks-workloads.sh
python3 scripts/verify_eks_realtime_kafka_mvp.py
python3 -m unittest \
  scripts.test_verify_eks_realtime_kafka_mvp \
  scripts.test_observe_eks_realtime_kafka_readiness
```

결과는 모두 pass다. 신규 chart는 default object 0, shadow worker 0, cutover에서만 V2 `continuous_sql` worker를 렌더한다. immutable digest, TLS/Secret/storage/NetworkPolicy/ServiceAccount, 구형 EC2 `all` fence, 대체 EC2 `kafka` owner, Realtime V1 fence, transfer 승인, generation과 V1/V2 동시 enable의 negative case가 실패하는 것을 확인했다. 기존 workload chart의 StatefulSet/PVC/Secret 기본 render 증가는 0건이다.

로컬에는 `terraform`과 `tofu` CLI가 없어 `terraform fmt -check`와 `terraform validate`는 실행하지 못했다. 검증 script는 이를 성공으로 가장하지 않고 `SKIP`으로 출력한다. apply 전 CI에서 [realtime workload identity](../infra/eks/terraform/realtime-workload-identity.tf)를 기존 EKS Terraform root에 연결한 뒤 fmt/validate/plan을 수행해야 한다.

## 전체 diff 범위 감사

최신 pair1 기준 tracked 30개, untracked 21개, 총 51개 파일이다. untracked 수에는 이 검증 기록이 포함된다.

```bash
git diff --check origin/pair1
git diff --name-status origin/pair1
git ls-files --others --exclude-standard
```

판정:

- ClickHouse 실시간 GOLD/EKS 이전 외 변경: 0건
- Airflow 경로 변경: 0건
- shared workload values/schema의 Airflow 관련 diff hunk: 0건
- Trino 구현·chart 변경: 0건
- Trino 언급은 ClickHouse identifier를 Trino mapping으로 가장하지 않는 API/architecture 보존 계약뿐이다.
- AWS access key, GitHub/OpenAI token, private-key header signature: 0건
- `node_modules`, `dist`, build, coverage, cache, `.pyc`, log 등 생성물/임시 파일: 0건
- merge conflict marker와 `git diff --check` 오류: 0건

감사 명령은 tracked diff와 `git ls-files --others --exclude-standard -z | xargs -0 rg ...`를 분리해 untracked 파일까지 검사했다. 예제 Secret은 key 이름과 외부 참조만 포함하며 실제 credential, 인증서 또는 private key를 포함하지 않는다.

## Live 단계 제한

실제 실행은 [EKS ClickHouse 실시간 GOLD 런북](eks-clickhouse-realtime-gold-runbook.md)을 따른다. 런북은 image digest, Secret/Pod Identity, hybrid/shadow, EC2·V1 quiesce, canonical owner의 원자 전환, Kafka→ClickHouse→GOLD→Dashboard, 장애 주입, 증거와 rollback 명령 및 실패 판정을 포함한다. live 권한 부재는 로컬 산출물 완료를 막지 않지만, 해당 receipt 없이는 production cutover 완료를 선언할 수 없다.
