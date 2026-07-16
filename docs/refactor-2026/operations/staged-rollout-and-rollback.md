# 단계적 rollout·관찰·rollback runbook

이 문서는 리팩토링 release를 준비하는 검증 가능한 template이다. **production 배포 권한을 부여하지 않으며**, `<...>` placeholder를 실제 승인값으로 치환하고 release owner의 승인을 받은 뒤에만 실행한다.

## 1. 실행 상태

- 감사 판정: guarded GO.
- plan 검증: `cd backend && npm run verify:refactor-release-plan`은 통과해야 한다.
- production 실행 검증: `npm run verify:refactor-release-execution`은 수동 증거 3건이 `passed`가 되기 전 exit 2로 차단된다.
- 수동 gate: 격리 nightly fault, production canary clean reboot, backup/restore drill.
- source of truth: [release-gates.json](../final/release-gates.json), [최종 감사](../final-audit.md).

## 2. Release 범위 고정

release record에 다음 값을 먼저 기록한다.

```bash
export RELEASE_ID="<YYYYMMDD-HHMM-refactor>"
export RELEASE_DIR="<approved-release-record-dir>/$RELEASE_ID"
export RELEASE_COMMIT="<fully-qualified-git-sha>"
export PREVIOUS_RELEASE_COMMIT="<fully-qualified-previous-sha>"

mkdir -p "$RELEASE_DIR"
git rev-parse HEAD | tee "$RELEASE_DIR/git-sha.txt"
git log --format='%H %s' "$PREVIOUS_RELEASE_COMMIT..$RELEASE_COMMIT" > "$RELEASE_DIR/commits.txt"
```

반드시 포함할 항목:

- PR 01~15와 merge 순서.
- migration 목록과 현재 head. migration이 없으면 `none`을 명시.
- backend/frontend/Spark/Airflow image tag와 immutable digest.
- feature flag와 compatibility adapter 상태.
- Compose 파일, env **key 이름만**, 배포 script checksum. env 값은 기록하지 않는다.

## 3. Pre-deploy checklist

- [ ] 모든 선행 PR이 순서대로 `dev`에 merge됐다.
- [ ] current release commit에서 CI가 다시 통과했다.
- [ ] `npm run verify:backward-compatibility` breaking 0.
- [ ] `npm run verify:legacy-paths` 통과.
- [ ] `npm run verify:quality-gates` 통과.
- [ ] `npm run verify:etl-e2e-recovery:release` 통과.
- [ ] 격리 runner의 nightly artifact가 release record에 있다.
- [ ] canary host와 canary Job/consumer group/topic/table/dashboard가 명시됐다.
- [ ] DB/object/config/image backup과 restore drill이 통과했다.
- [ ] rollback owner, incident channel, 최대 판단 시간이 지정됐다.
- [ ] static AWS/MinIO credential이 artifact/log에 없다.

## 4. Backup과 복구 지점

### Metadata DB

읽기 가능한 일관 snapshot을 만들고 checksum을 기록한다. connection string은 secret manager 또는 process env에서만 읽는다.

```bash
pg_dump --format=custom --no-owner --file "$RELEASE_DIR/metadata.dump" "$DATABASE_URL"
sha256sum "$RELEASE_DIR/metadata.dump" > "$RELEASE_DIR/metadata.dump.sha256"
pg_restore --list "$RELEASE_DIR/metadata.dump" > "$RELEASE_DIR/metadata.dump.contents"
```

격리 DB 복원 후 baseline/current binary가 기존 Job, session, runtime row를 읽는 compatibility test를 실행한다. production DB에 수동 SQL update를 하지 않는다.

### Checkpoint/report/manifest

삭제나 전체 복사 대신 version/etag/checksum inventory를 고정한다.

```bash
aws s3api list-objects-v2 \
  --bucket "<output-bucket>" \
  --prefix "<canary-prefix>/" \
  --output json > "$RELEASE_DIR/object-inventory.json"
sha256sum "$RELEASE_DIR/object-inventory.json" > "$RELEASE_DIR/object-inventory.sha256"
```

- bucket versioning이 활성화된 경우 version ID도 기록한다.
- rollback 시 checkpoint를 임의로 과거로 덮지 않는다.
- manifest fingerprint conflict가 발생하면 canary worker를 fencing하고 운영 판단을 기다린다.

### Compose/env/image

```bash
docker compose --env-file "<approved-env-file>" -f deploy/docker-compose.prod.yml config > "$RELEASE_DIR/compose.rendered.yml"
sha256sum deploy/docker-compose.prod.yml scripts/deploy.sh "$RELEASE_DIR/compose.rendered.yml" > "$RELEASE_DIR/deploy.sha256"
docker image inspect "<backend-image>" "<frontend-image>" "<spark-image>" > "$RELEASE_DIR/images.json"
```

`compose.rendered.yml`에 secret 값이 포함될 수 있으므로 접근 제한된 release record에만 저장하고 자동 redaction 검사를 먼저 적용한다.

## 5. 배포 순서

각 단계는 별도 승인·중단·재개·rollback 지점이다.

1. **Expand/backup**: additive DB/config만 적용하고 old binary read를 검증한다.
2. **Backward-compatible backend canary**: canary host 한 대에 immutable digest를 배포한다.
3. **Runtime worker canary**: 비핵심 Kafka Job 하나만 새 worker로 fencing takeover한다.
4. **Frontend canary**: canary route/user group에만 새 frontend를 노출한다.
5. **10% → 25% → 50% → 100%**: 각 구간 최소 30분 관찰 뒤 진행한다.
6. **Flag rollout**: compatibility reader를 유지한 채 additive flag만 연다.
7. **Contract cleanup**: 30일 0-call과 rollback window 종료 뒤 별도 PR/release로 수행한다.

실제 명령은 조직의 승인된 deploy wrapper를 사용한다. 예시 template:

```bash
<deploy-wrapper> backend --image "<digest>" --scope "<canary-host>" --release "$RELEASE_ID"
<deploy-wrapper> worker --image "<digest>" --scope "<canary-job>" --release "$RELEASE_ID"
<deploy-wrapper> frontend --image "<digest>" --scope "<canary-route>" --release "$RELEASE_ID"
<traffic-wrapper> promote --release "$RELEASE_ID" --percent "<10|25|50|100>"
```

## 6. Mixed-version 호환성

- expand 동안 old backend/worker가 새 nullable/additive field를 무시할 수 있어야 한다.
- 새 backend는 versionless report/checkpoint와 legacy runtime row를 telemetry와 함께 읽는다.
- 새 worker의 report/manifest version field는 old backend가 무시할 수 있어야 한다.
- frontend는 additive response field 없이도 기존 화면을 표시해야 한다.
- compatibility 검증:

```bash
cd backend
npm run verify:backward-compatibility
npm run verify:legacy-paths
PYTHONPATH=. .venv/bin/python -m unittest tests.test_backward_compatibility_contracts -v
```

## 7. Smoke와 관찰 query

### 즉시 smoke

```bash
curl -fsS "<base-url>/api/health/live"
curl -fsS "<base-url>/api/health/ready"
curl -fsS "<base-url>/api/health/metrics" > "$RELEASE_DIR/metrics-$(date +%s).json"
```

canary Job에서 다음을 확인한다.

- command revision이 한 번만 증가한다.
- active worker fencing token이 하나다.
- consumed/persisted count가 단조 증가하고 duplicate/loss가 0이다.
- checkpoint와 manifest fingerprint가 rollback하지 않는다.
- output→Catalog→Dashboard revision이 순서대로 수렴한다.
- frontend stale poll이 최신 revision을 덮지 않는다.

### 로그 query template

```bash
<log-query> --release "$RELEASE_ID" --since 30m \
  --events 'api_error,compatibility.path.used,runtime.reconcile,report_missing,storage_unwritable,catalog_publication_failed,dashboard_publication_failed'
```

모든 query는 `releaseId`, `correlationId`, `jobId`, `runId`, `batchId`를 함께 보여야 한다. process-local counter는 restart 때 초기화되므로 장기 SLO source of truth로 사용하지 않는다.

## 8. Clean reboot gate

canary 30분 정상 뒤 canary host만 clean reboot한다.

1. reboot 전 Job/runtime/checkpoint/manifest revision 기록.
2. 승인된 EC2 reboot 수행.
3. Docker daemon의 restart policy로 서비스 복구 확인.
4. Spark ivy/report/run 경로 owner UID 185와 쓰기 smoke 확인.
5. backend/Spark worker 단독 restart 각각 수행.
6. 수동 SSH `mkdir/chown`, DB 편집 없이 reconcile 수렴 확인.
7. 기존 checkpoint부터 중복 없이 처리 재개 확인.

하나라도 실패하면 100% rollout을 중단한다.

## 9. Rollback decision table

| trigger | threshold | 판단 시간 | action |
|---|---|---:|---|
| command 실패, unknown/stale reconcile, report/storage 오류 | canary 1건 또는 15분 baseline 초과 | 5분 | 확장 중지, backend/worker 이전 digest |
| duplicate/loss/checkpoint rollback/manifest conflict | 1건 | 5분 | canary consumer fencing, 이전 worker digest |
| Spark terminal failure 급증 | 3회 연속 또는 baseline 2배 | 10분 | worker rollback, source producer는 보존 |
| Catalog/Dashboard 발행 실패 | 5분 지속 또는 3회 연속 | 10분 | 실패 publication 단계만 중지/재개 |
| frontend error/stale poll | 5분 지속 | 10분 | frontend 이전 digest, backend 유지 |
| clean reboot 복구 실패 | 1회 | 15분 | rollout 중단, 이전 release 복귀 |

## 10. Rollback template

```bash
<traffic-wrapper> freeze --release "$RELEASE_ID"
<deploy-wrapper> frontend --image "<previous-frontend-digest>" --scope "<affected-scope>"
<deploy-wrapper> worker --image "<previous-worker-digest>" --scope "<affected-scope>"
<deploy-wrapper> backend --image "<previous-backend-digest>" --scope "<affected-scope>"
<traffic-wrapper> route --percent 100 --to "$PREVIOUS_RELEASE_COMMIT"
```

- additive DB shape와 새 artifact field는 그대로 둔다. old reader compatibility 검증을 먼저 실행한다.
- DB restore는 데이터 손상과 운영 승인 근거가 있을 때만 별도 incident 절차로 수행한다.
- checkpoint/report/manifest를 삭제하거나 수동으로 숫자를 낮추지 않는다.
- rollback 뒤 같은 smoke, metrics, Catalog/Dashboard convergence를 다시 확인한다.

## 11. Post-deploy, 24h, 72h

### 배포 직후

- [ ] 모든 phase release digest와 시간을 기록했다.
- [ ] smoke, canary Job, Catalog/Dashboard, browser가 정상이다.
- [ ] rollback trigger가 0이다.
- [ ] clean reboot evidence가 있다.

### 24시간

- [ ] command/reconcile/runtime/publication/frontend 오류율이 baseline 이하다.
- [ ] compatibility path별 호출량과 top caller를 기록했다.
- [ ] duplicate/loss/checkpoint rollback이 0이다.
- [ ] 수동 chown/DB 수정이 0이다.

### 72시간

- [ ] delayed batch와 scheduled Job까지 정상이다.
- [ ] fallback/legacy 활성화가 예상 범위다.
- [ ] cleanup issue의 owner/date가 유효하다.
- [ ] 100% 유지 또는 rollback 종료 결정을 release record에 남겼다.

## 12. Cleanup backlog

| 후보 | owner | 제거 조건 | 목표 |
|---|---|---|---|
| `etl_service.py` 핵심 orchestration | data-platform | façade 신규 로직 0, application coverage 유지 | 2026-09-15 |
| Node connector 중복 authority | data-platform | Python/Node parity와 bridge counter 0 | 2026-09-30 |
| ETL global CSS 중복 | analytics-experience | visual regression 동일 | 2026-09-30 |
| production compatibility adapters | 각 registry owner | 30일 0-call, old artifact backfill, rollback window 종료 | 2026-10-31 |
| oversized quality allowlist | maintainer | 파일/함수가 threshold 아래로 내려감 | 지속 |

cleanup은 현재 release에 섞지 않고 각각 linked issue와 별도 contract PR로 처리한다.
