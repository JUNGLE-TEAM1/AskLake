# 10 — SQL Service·Catalog 경계 정리 Codex 프롬프트

## 목표

`sql_service.py`, Catalog 등록/조회, ETL publication 사이의 책임을 정리해 ETL God Service와 SQL God Service가 서로 상태를 우회 수정하지 못하게 한다.

## Codex에 전달할 프롬프트

SQL/Trino/DuckDB compatibility 경로와 Catalog service/repository를 실제 코드에서 추적하고, 명시적 경계로 리팩토링하라.

### 조사 질문

- SQL job 생성과 일반 ETL pipeline 생성이 공유하는 계약은 무엇인가?
- Catalog dataset identity의 canonical owner는 어디인가?
- Trino/Iceberg 등록과 query execution은 누가 책임지는가?
- DuckDB fallback/compatibility는 production에서 도달 가능한가?
- CatalogPage가 기대하는 response shape는 어디서 조립되는가?

### 구현 작업

1. SQL 분석, query execution, derived dataset publication, Catalog metadata update를 분리한다.
2. ETL application layer는 Catalog port를 통해 등록 요청만 하고 Catalog 내부 DB 세부를 직접 변경하지 않는다.
3. SQL service가 ETL runtime/session을 우회 수정하지 못하게 한다.
4. dataset identity, version, physical location, query engine identity mapper를 한곳에 둔다.
5. Trino와 compatibility engine의 선택 조건을 명시적 policy/config로 옮긴다.
6. fallback 사용 시 structured warning/metric을 남긴다.
7. 기존 SQL/ETL API와 Catalog response contract를 유지한다.
8. 대형 함수는 parse/plan/execute/publish 책임으로 나누되, 단순 helper 난립은 피한다.
9. Catalog 등록의 idempotency와 duplicate dataset 방지 테스트를 추가한다.

### 완료 기준

- ETL, SQL, Catalog의 writer 권한이 서로 충돌하지 않는다.
- dataset identity가 한 mapper/policy에서 결정된다.
- fallback engine 사용 여부를 운영에서 확인할 수 있다.
- `sql_service.py`와 ETL service의 상호 결합이 줄었다.
- Catalog frontend가 기존 계약으로 계속 동작한다.
