# 7월 15일 EKS Auto Mode ALB 기반 적용 기록

## 적용 범위

dev 공개 진입 계약은 `internet-facing`, Pod IP를 직접 대상으로 하는 `ip`, `ipv4`, AWS가 생성하는 ALB DNS와 HTTP 80으로 정했다. 사용자 도메인, Route 53 record, ACM certificate와 HTTPS 전환은 보류했다.

최종 Frontend/FastAPI Service가 아직 준비되지 않았으므로 route를 임시 workload에 연결하지 않았다. `routesEnabled=false`로 IngressClassParams와 IngressClass만 적용했다. 기존 EC2, Caddy, DNS와 현재 사용자 트래픽은 변경하지 않았다.

```text
현재
IngressClassParams 1개 → IngressClass 1개 → Ingress 0개 → ALB 0개

최종 Service 준비 후
IngressClass → Backend /api Ingress + Frontend / Ingress → EKS Auto Mode ALB
```

## 실행 결과

- Helm release `asklake-ingress` revision 1이 `deployed` 상태다.
- 환경별 IngressClassParams와 IngressClass가 각각 1개 존재한다.
- namespace selector는 `asklake-dev`의 전용 ingress access label로 제한된다.
- public subnet 두 개, `internet-facing`, `ip`, `ipv4`, HTTP listener 계약이 server-side dry-run을 통과했다.
- Ingress는 0개이며 적용 전후 AWS ELBv2 load balancer 수는 모두 0개였다.
- Terraform apply는 실제 resource를 변경하지 않고 Phase 7/13 handoff output만 갱신했다.

실제 subnet ID, account ID, endpoint와 환경 values는 저장소에 기록하지 않는다.

## 남은 완료 기준

1. B가 최종 `frontend:80`, `fastapi:8080` ClusterIP Service와 readiness를 제공한다.
2. 실제 workload values와 Secret/ConfigMap 계약을 검증한다.
3. 저장소 밖 values에서 `routesEnabled=true`로 바꾸고 비용 confirmation 후 두 Ingress를 적용한다.
4. ALB hostname과 target health를 확인한다.
5. AWS 생성 hostname에서 `/`와 `/api/health`의 HTTP smoke를 통과시킨다.
6. 이후 도메인·ACM·HTTPS를 선택하면 listener 계약과 DNS ownership을 별도 변경한다.

기반 적용만으로 Phase 13 runtime 완료나 웹 공개 완료를 선언하지 않는다.
