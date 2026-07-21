# EKS 16일차 Phase 4 보완 검수 기록

## 목적

Phase 4 live 수렴 뒤 현재는 정상이어도 재실행·복구 또는 full-service 전환에서 깨질 수 있는 운영 스크립트를 보완한다. 이번 작업은 tracked contract, script, fake test와 문서만 변경하며 AWS Secret, ExternalSecret, Helm release와 Pod를 변경하지 않는다.

## 검수에서 발견한 문제

Backend manifest와 live target은 12-key로 확장됐지만 기존 handover와 rollback helper는 DB 2-key만 비교·복구했다. 문서에는 `--handover`가 계속 실행 가능한 명령으로 남아 있어 장애 복구에 사용하면 Airflow와 Trino key를 유실할 수 있었다.

bounded 12-key 배열도 handoff audit, runtime delivery, image preflight와 runtime verifier에 반복돼 있었다. AI 선택 뒤 full-service target이 17-key로 확장돼도 일부 verifier가 계속 12-key만 허용해 ready/rollout이 영구 차단될 수 있었다.

Trino password database의 plaintext 전달은 manifest grep과 실제 private input 검증에 의존했고, Base64 문자열·제3 identity·낮은 bcrypt cost를 독립적으로 막는 pure regression test가 없었다.

## 보완 결과

`runtime-secret-contract.example.json`에 Backend active `bounded` profile과 exact 12-key 집합을 추가했다. full-service 집합은 기존 `secrets.backend.keys`를 사용한다. 공통 shell helper가 두 scope를 읽고 정적 verifier가 bounded exact set, active profile과 full-service 부분집합 관계를 확인한다.

다음 경로가 자체 12-key 배열 대신 profile을 사용한다.

- Backend source/target verifier
- image rollout preflight
- day16 runtime Secret delivery verifier
- day16 handoff audit
- Backend handover와 rollback

`--audit`은 bounded scope를 사용한다. `--ready`는 full-service scope를 사용하며 AI decision과 17-key source/target이 준비되지 않으면 fail-closed한다. AI 선택 자체는 변경하지 않았다.

handover는 source, manual target과 staged target의 exact bounded set과 전체 hash를 비교한다. rollback도 source의 12개 전체를 복구하며 canonical Secret 단독 참조, FastAPI 2/2와 ALB/RDS health를 검증한다. DB 2-key 축소 복구 패턴은 regression test에서 금지한다.

Trino password database 검증을 pure module로 분리했다. 정확한 두 approved identity, bcrypt 형식과 cost를 검사하고 빈 줄은 허용한다. Base64 문자열, 제3·중복 identity, 낮은 cost와 malformed hash는 거부한다. JKS만 ESO Base64 decode 대상이라는 manifest gate는 유지한다.

## 검증 경계

fake 검증은 정상 12-key 복구, source/target hash drift, missing/extra key, delete/apply/rollout 실패와 축소 복구 금지를 포함한다. runtime contract test는 bounded profile 누락·미승인 key·active profile drift를 포함한다.

민감정보 검사는 `git ls-files`로 얻은 tracked 파일에만 수행한다. Git 제외 private JSON, 실제 credential, endpoint, ARN과 digest 원문은 출력하거나 문서에 기록하지 않는다.

## 남은 결정

AI runtime과 provider workload는 계속 미선택이다. 이번 보완은 full-service를 선택한 것이 아니라, 나중에 선택·source 확장이 끝났을 때 12-key hardcode 때문에 배포 gate가 통과 불가능해지는 문제만 제거했다.
