# EKS MVP 7월 15일 Private Network 검증 기록

## 검증 범위

2026-07-15 서울 리전 dev EKS에서 private subnet 배치, VPC DNS, NAT egress, RDS/MSK service security group과 Auto Mode Network Policy를 실제 검증했다. 실제 VPC/subnet/security group ID, endpoint, account ID와 object key는 이 문서에 기록하지 않는다.

## 배치와 route 결과

- EKS node와 smoke Pod는 검토된 두 private subnet CIDR 안에서 실행됐다.
- node에 External IP가 없고 public/private subnet 모두 Pod/instance 자동 public IP 할당이 꺼져 있다.
- private subnet 두 개는 단일 NAT Gateway 기본 route를 사용한다.
- public subnet 두 개는 Internet Gateway 기본 route를 사용한다.
- VPC DNS support와 DNS hostnames가 활성화돼 있다.

단일 NAT Gateway는 dev 비용 절감 선택이며 해당 AZ 장애와 cross-AZ egress 위험이 남는다. staging/production에서는 per-AZ NAT 또는 endpoint/hybrid 구성을 다시 결정한다.

## 실제 EKS Pod 연결 결과

Backend Pod Identity ServiceAccount를 사용한 임시 Pod에서 다음을 확인했다.

- RDS endpoint가 VPC private IP로 해석됨
- MSK IAM bootstrap hostname이 VPC private IP로 해석됨
- RDS `5432/tcp` 연결 성공
- MSK IAM listener `9098/tcp` 연결 성공
- RDS의 잘못된 `9098/tcp` 접근 실패
- MSK의 잘못된 `5432/tcp` 접근 실패
- STS 호출 성공
- 승인된 기존 Raw object의 S3 `HeadObject` 성공

Raw bucket의 `GetBucketLocation`과 `ListBucket`은 Backend role에 허용되지 않아 거부됐다. 이는 network 실패가 아니라 object read-only 최소 권한의 negative 증거다. 검증 Pod는 종료 후 삭제했다.

MSK `9098` 성공은 TCP와 private DNS 증거다. Kafka IAM 인증, fixture topic metadata와 기존 Continuous topic/group 차단은 Kafka IAM client가 준비된 뒤 별도 검증한다.

## Security group과 외부 차단

- RDS security group은 EKS cluster security group source의 `5432/tcp` 규칙 한 개만 가진다.
- MSK security group은 같은 source의 `9098/tcp` 규칙 한 개만 가진다.
- RDS/MSK/cluster security group inbound에 `0.0.0.0/0` 또는 `::/0` 공개 규칙이 없다.
- VPC 밖 개발자 PC에서 RDS `5432`와 MSK `9098` 연결이 실패했다.
- RDS public access는 비활성 상태다.

## Auto Mode Network Policy

AWS 공식 Auto Mode 방식에 따라 `kube-system/amazon-vpc-cni` ConfigMap으로 Network Policy Controller를 활성화했다. General/Spark NodeClass는 `DefaultAllow`, event log는 `Disabled`로 명시했다.

임시 namespace에서 다음 순서로 enforcement를 확인했다.

1. 정책이 없을 때 client → server HTTP 성공
2. server ingress를 선택한 deny NetworkPolicy 적용 후 연결 실패
3. 정책 삭제 후 연결 복구
4. 임시 namespace 삭제

`DefaultAllow`는 정책 기능을 활성화하되 아직 통신 계약이 없는 workload를 자동 차단하지 않는 전환 설정이다. 실제 Frontend/FastAPI/Airflow/Spark/Trino가 배포되기 전에 B의 Service·DNS·port 계약을 받아 namespace 기본 deny와 workload별 allow 정책을 별도 manifest로 만든다.

## 남은 작업

- Kafka IAM client의 MSK 인증과 topic/group positive·negative 검증
- 실제 workload별 Kubernetes NetworkPolicy
- ALB target health와 `/`, `/api/health` 연결
- Airflow, Trino와 Spark 간 Service DNS/port 검증
- 단일 NAT Gateway의 장애·비용 기준선과 staging/production topology 결정

이 항목이 끝나기 전에는 전체 EKS network 전환 완료로 선언하지 않는다.
