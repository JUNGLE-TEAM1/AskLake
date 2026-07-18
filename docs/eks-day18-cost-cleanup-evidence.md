# EKS Day 18 Phase 3 비용·정리 가드레일

## 결론

2026-07-18 dev 환경에 관리 대상 로그 그룹 합산 기준의 일일 유입량 경고와 저장량
경고를 Terraform으로 추가했다. 경계는 각각 `3 GiB/day`, `20 GiB stored`이고 실제
알림 대상은 아직 승인되지 않아 alarm action은 비활성이다. 두 alarm은 적용 후 모두
존재하며, 이 단계는 Slack·이메일 통보 완료를 주장하지 않는다.

최초 OTel native application log와 기존 control-plane/RDS 유입을 함께 24시간으로
보정하자 일일 경계를 넘을 가능성이 확인됐다. 짧은 구간의 선형 예측은 청구액 자체가
아니라 조기 중단용 신호다. cluster 전체 application 로그를 계속 보내지 않고 같은 관리형 add-on의
Fluent Bit custom config로 전환해 `asklake-dev` container 파일만 기존 application log
group으로 보낸다. dataplane·host log 입력은 비활성이고 control-plane/RDS log의 7일
retention은 그대로다.

## 구현 경계

- Application Signals와 Classic Container Insights는 계속 비활성이다.
- OTel Container Insights metric은 유지하되 OTel file log receiver는 끈다.
- add-on이 관리하는 Fluent Bit만 사용하며 별도 chart나 standalone collector는 만들지
  않는다.
- file path의 namespace segment를 exact include하고 cluster-wide `*.log` path는
  허용하지 않는다.
- Fluent Bit은 General과 Spark taint만 허용하므로 system 전용 Node에는 배치되지 않는다.
- Pod association endpoint 오류를 피하기 위해 kubelet metadata 경로를 사용한다.
- application/control-plane/RDS log group은 destroy 때 보존하고 retention은 7일이다.

## 비용 판정 방식

`scripts/capture-eks-day18-cost-cleanup-evidence.sh --capture`는 저장소 밖 mode `0600`
receipt만 만든다. 과거 24시간 유입량을 그대로 일일 예측으로 오인하지 않고 현재 Ready
Fluent Bit Pod의 시작 시각 이후 application 유입량을 24시간으로 보정한다. 그 값에
control-plane/RDS의 실제 최근 24시간 유입량을 더해 `3 GiB/day`와 월 `75 USD` 검토
경계를 판정한다. 현재 collector 관찰이 5분보다 짧으면 실패하고, 24시간이 지나기
전에는 `fullApplication24hWindow=false`를 남긴다.

월 비용은 decision record의 서울 리전 검토 단가를 사용한 단순 ingest 예측이며 AWS
청구서가 아니다. 24시간이 지난 뒤 같은 runner를 다시 실행해 full-window 판정을
확정해야 한다.

## scale-in과 cleanup

Day 17 격리 증거는 General/Spark가 baseline에서 증가한 뒤 다시 복귀했음을 증명한다.
Phase 3 실행 중 다른 bounded Spark 실행이 막 끝나 기본 `timeToLiveSeconds: 3600`의
Succeeded driver Pod가 Spark Node를 잠시 유지했다. 이 application은 active가 아니며
TTL 자동 삭제 대상이다. 장기 증거용 application은 별도 스크립트가 TTL을 7일로
늘렸지만 driver Pod가 없어 Node를 붙잡지 않는다.

runner는 현재 Node가 baseline이면 `currentScaleInState=true`를 기록한다. 그렇지 않으면
active Spark가 0이고, 완료 application이 기본 1시간 TTL 안에 있으며, General Node가
baseline을 넘지 않을 때만 `boundedAutomaticCleanupPending=true`로 구분한다. 이를 완전
복귀로 표시하지 않으며 다른 작업자의 완료 application이나 durable RDS/Catalog/Iceberg
증거를 삭제하지 않는다.

최종 관찰에서는 Spark Node가 baseline으로 자동 복귀했고 active Job/SparkApplication,
Pending·terminating Pod, scale/load fixture release와 의심 임시 resource가 0이었다.
Deployment 7개는 모두 steady였다.

## 검증 결과와 남은 gate

- Terraform validate와 observability mock test 3개가 통과했다.
- plan은 add-on in-place update와 alarm 2개 생성만 포함했고 destroy는 0이었다.
- add-on은 `ACTIVE`, managed Fluent Bit과 agent는 desired/ready가 일치하고 restart가 0이다.
- live Fluent Bit config는 `asklake-dev` exact path만 포함하며 cluster-wide path,
  dataplane·host input이 없다.
- 두 비용 alarm은 존재하지만 승인된 notification target이 없어 action은 비활성이다.
- 새 collector 약 6분의 application 유입을 보정한 값은 약 `0.20 GiB/day`, 기존
  control-plane은 최근 24시간 약 `2.42 GiB`, RDS는 `0.001 GiB` 미만이었다. 합산 예측은
  약 `2.62 GiB/day`, 단순 월 ingest 예측은 약 `64.18 USD`로 현재 경계 안이지만 여유가
  크지 않다.
- OTel metric exporter의 일부 HTTP 400 drop은 application log 비용 수정과 별개의 Phase 2
  후속 gate다.
- 현재 collector의 24시간 full-window 비용 재측정은 시간이 지나야 닫을 수 있다.

원본 metric, resource identity와 receipt는 `/private/tmp`의 mode `0600` 파일로만 보존하며
Git에는 endpoint, ARN, digest, Pod/Node 이름을 기록하지 않는다.
