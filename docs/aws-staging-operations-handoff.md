# AWS Staging 운영 인계

이 문서는 Issue #727 Phase 6의 실제 AWS staging 실행을 다른 운영자가 재현하고, evidence·비용·정리 상태를 같은 기준으로 판단하기 위한 runbook이다. 일반 AskLake 배포나 production Runtime 전환 절차가 아니다.

## 실행 전 확인

1. GitHub 기본 브랜치에 staging workflow가 존재하고 `AWS_ACCOUNT_ID`, `AWS_GITHUB_OIDC_ROLE_ARN`, `AWS_TERRAFORM_STATE_BUCKET`, `AWS_TERRAFORM_STATE_KMS_KEY_ARN`이 해당 Environment에 설정돼 있어야 한다.
2. AWS OIDC role은 Terraform state S3의 List/Get, staging artifact/evidence S3의 Get/Put, KMS, SSM Send/GetCommand, Pricing, Terraform이 생성하는 staging resource 제어 권한을 가져야 한다. 장기 access key를 추가하지 않는다.
3. `asklake-aws-staging-apply`, `artifacts`, `smoke`, `destroy`, `ttl-sweep` Environment의 승인 정책을 확인한다. smoke는 대상 stack 확인 뒤 completion receipt를 남기고, cleanup plan artifact 검토 뒤 teardown은 별도 `destroy` 보호 Environment 승인에서만 수행한다.
4. 실제 EMR Serverless quota, Budget 알림 수신자, approved smoke-runner AMI, state backend가 준비됐는지 platform 담당자에게 확인한다.

## 실행 순서와 보존물

| 순서 | 수동 workflow | 확인할 보존물 | 실패 시 |
| --- | --- | --- | --- |
| 1 | Plan/Apply | plan fingerprint, redacted Runtime manifest | apply 전 중단 |
| 2 | Artifacts | JAR bundle manifest, smoke bundle SHA-256, delivery receipt | artifact를 수정하고 재실행 |
| 3 | Smoke | smoke evidence, price snapshot, Batch/Continuous report, cleanup receipt | evidence export 뒤 teardown 상태 확인 |
| 4 | TTL Sweep | redacted state expiry evidence | 만료/invalid이면 `destroy:<stackId>` 승인 |
| 5 | Destroy | destroy plan/result receipt | 잔존 resource를 platform 담당자와 확인 |

state/runner가 확인된 smoke는 성공 여부와 관계없이 `asklake.aws-staging-smoke-run.v1` completion receipt와 `asklake.aws-staging-smoke-cleanup.v1` receipt가 있어야 한다. SSM 실행을 시작했는데 evidence가 없거나, protected cleanup 승인 뒤 cleanup receipt가 없으면 Phase 5는 통과가 아니며, 기존 `AWS Staging Destroy` workflow로 해당 stack을 수동 정리한다.

## Handoff bundle 생성

실제 run의 redacted 파일 세 개를 내려받은 뒤 다음 명령으로 JSON과 Markdown handoff를 만든다. 입력과 출력은 Git ignore 대상 private 작업 디렉터리에만 둔다.

```bash
cd backend
npm run aws-staging:render-handoff -- \
  --smoke-evidence /secure-run/smoke-evidence.json \
  --cleanup-receipt /secure-run/cleanup-receipt.json \
  --ttl-sweep-evidence /secure-run/ttl-sweep.json \
  --output-json /secure-run/handoff.json \
  --output-markdown /secure-run/handoff.md
```

생성기는 다음을 fail-closed로 확인한다.

- smoke의 exact count, lag/quarantine, checkpoint, EMR Job Run, S3 report와 price snapshot
- cleanup receipt의 stack/source revision/plan fingerprint 일치
- TTL evidence에 expired/invalid state가 없는지
- broker, credential, authorization 등 민감 값이 handoff에 없는지

이 bundle은 smoke가 기능 연결을 통과했다는 운영 기록일 뿐 Phase 7 성능 승인이 아니다.

## 비용·장애 기록

각 실제 run에 아래를 남긴다.

- GitHub run URL, stack ID, source revision, runtime/smoke bundle SHA-256
- EMR Batch 1개와 Continuous 2개 `applicationId`/`jobRunId`, `GetJobRun.billedResourceUtilization`
- Seoul EMR price snapshot S3 URI와 필요 시 Cost Explorer 실제 비용 범위
- Batch/Continuous S3 report URI, CloudWatch log group/query 또는 metric evidence URI
- smoke cleanup receipt와 가장 최근 TTL sweep artifact URL
- 실패라면 failure code, evidence export 여부, destroy 결과와 남은 resource 이름이 아닌 안전한 resource type/count

bootstrap broker 원문, credential, session token, authorization header, Terraform state 원문은 handoff/Issue/PR에 올리지 않는다.

## Phase 7 pilot으로 넘기는 기준

다음 항목이 모두 있어야 Phase 7 pilot을 별도 승인할 수 있다.

- Phase 4 success evidence와 Phase 5 cleanup/TTL evidence가 실제 AWS에서 생성됨
- 전용 topic/group/output/checkpoint와 Budget 상한이 다시 승인됨
- approved SLO profile, 동일 source revision과 artifact SHA-256, 8개 부하·8개 장애 시나리오 계획
- CloudWatch worker metric 원본 위치와 EMR billed resource 세 필드, price snapshot/실제 비용 근거
- 같은 구성으로 최소 3회 반복할 운영 시간과 담당자

상세 시나리오와 `insufficient-evidence` 판정은 [Kafka·Spark Phase 7 부하·장애·비용 검증](kafka-spark-phase7-validation.md)을 따른다.

## AWS 오피스아워 질문

인터넷 문서로 답을 얻을 수 있는 일반 제품 설명은 제외하고, 이 계정·조직에서만 확인 가능한 사항을 묻는다.

1. GitHub OIDC trust policy가 이 repository의 각 protected Environment와 기본 브랜치 dispatch를 허용하는 정확한 subject 조건은 무엇인가?
2. Terraform control-plane role에 state S3/KMS와 staging artifact/evidence S3, SSM, Pricing 권한을 어떤 기존 permission boundary 안에서 부여할 수 있는가?
3. Seoul EMR Serverless concurrent vCPU quota와 증액 승인 리드타임은 얼마이며, smoke/Phase 7의 계정-level 동시 사용량을 어떤 방식으로 예약·관찰하는가?
4. `StackId` cost allocation tag 활성화와 Budget 알림 수신 경로의 조직 표준은 무엇이며, 실제 Cost Explorer 반영 지연은 어느 정도인가?
5. private smoke runner AMI의 소유·패치·SSM agent·Node 22 기준은 무엇이며, AMI 변경 승인 프로세스는 무엇인가?
6. 매시 TTL audit이 expired/invalid stack을 발견했을 때의 담당자, 응답 시간, 보호 destroy Environment 승인자는 누구인가?
7. CloudWatch metric/log retention과 Cost Explorer export를 Phase 7 evidence로 보존할 조직 표준 위치와 retention은 무엇인가?
