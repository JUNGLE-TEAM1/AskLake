import type React from "react";
import { getSourceBrandMeta, SourceBrandIcon } from "../../components/source/SourceBrand";
import { type SourceConnectorDefaults } from "../../services/sourceConnectorService";

import {
  OBJECT_STORAGE_IS_AWS,
  OBJECT_STORAGE_PROVIDER_LABEL,
  OBJECT_STORAGE_REGION
} from "./sourceModel";

export type SourceConnectorMeta = {
  description: string;
  icon: React.ReactNode;
  label: string;
  status: string;
};

export type SourceConnectionDefinition = {
  assets: Array<[string, string, string]>;
  assetsTitle: string;
  description: string;
  fields: Array<[string, string]>;
  fieldSuggestions?: Record<string, string>;
  info?: string;
  logs: string[];
  previewColumns: string[];
  previewNote: string;
  previewRows: string[][];
  previewTitle: string;
  testItems: Array<[string, string]>;
  title: string;
};

export function buildSourceConnectionDefinitions(sourceDefaults: SourceConnectorDefaults) {
  const connectorMeta: Record<string, SourceConnectorMeta> = {
    "File / S3": { description: "S3 버킷의 CSV, JSON, Parquet 파일을 가져옵니다.", icon: <SourceBrandIcon kind="s3" />, label: getSourceBrandMeta("File / S3").label, status: "실제 연결" },
    PostgreSQL: { description: "PostgreSQL 테이블에서 데이터를 가져옵니다.", icon: <SourceBrandIcon kind="postgres" />, label: getSourceBrandMeta("PostgreSQL").label, status: "실제 연결" },
    MongoDB: { description: "MongoDB 컬렉션에서 문서를 가져옵니다.", icon: <SourceBrandIcon kind="mongo" />, label: getSourceBrandMeta("MongoDB").label, status: "실제 연결" },
    "REST API": { description: "API를 호출해 응답 데이터를 가져옵니다.", icon: <SourceBrandIcon kind="rest" />, label: getSourceBrandMeta("REST API").label, status: "실제 연결" },
    "Data Lake": { description: "AskLake에 저장된 데이터셋을 다시 사용합니다.", icon: <SourceBrandIcon kind="lake" />, label: getSourceBrandMeta("Data Lake").label, status: "목록 조회" },
    "SQL Result": { description: "검증된 SQL 분석 결과를 다시 사용합니다.", icon: <SourceBrandIcon kind="sql" />, label: getSourceBrandMeta("SQL Result").label, status: "검증 완료" },
    "Stream / Kafka": { description: "Kafka에서 들어오는 데이터를 실시간 또는 구간별로 가져옵니다.", icon: <SourceBrandIcon kind="kafka" />, label: getSourceBrandMeta("Stream / Kafka").label, status: "메타데이터" },
  };
  const sourceConfigs: Record<string, SourceConnectionDefinition> = {
    "SQL Result": {
      title: "SQL 결과 입력",
      description: "SQL Preview 결과와 query/run metadata를 처리 Job 입력으로 사용합니다.",
      fields: [
        ["Source Dataset", ""],
        ["Source Dataset ID", ""],
        ["SQL Run ID", ""],
        ["Preview Limit", "100"],
        ["Preview Row Count", ""],
        ["Reference Dataset IDs", "-"],
        ["Validation Key", "-"],
        ["Query", ""],
      ],
      testItems: [["SQL Preview", "Verified"], ["Query", "Read-only"], ["Backend connector", "Skipped"]],
      logs: ["SQL Preview 결과가 이미 검증되어 소스 연결 단계를 생략합니다.", "Review에서 Job 생성 후 실행 정책과 타겟 저장소를 확정합니다."],
      assetsTitle: "SQL 실행 근거",
      assets: [],
      previewTitle: "SQL Preview 결과",
      previewNote: "SQL 분석 화면에서 전달된 Preview 결과를 사용합니다.",
      previewColumns: ["Column", "Type", "Source"],
      previewRows: [],
      info: "SQL 결과 저장은 Catalog 직접 저장이 아니라 수집/처리 Job 생성 검토로 이어집니다.",
    },
    PostgreSQL: {
      title: "PostgreSQL 연결",
      description: "백엔드 커넥터가 PostgreSQL 테이블 목록, 샘플 행, 스키마를 조회합니다.",
      fields: [
        ["Endpoint / Host", "127.0.0.1"],
        ["Port", "15432"],
        ["Database Name", "asklake_sources"],
        ["Schema", "public"],
        ["Username", "asklake"],
        ["Password / Auth Token", "asklake"],
        ["DATASET OR TABLE SELECTOR", ""],
      ],
      testItems: [["Endpoint", "Not tested"], ["Database", "Pending"], ["Target discovery", "After connection"]],
      logs: ["PostgreSQL 소스 식별은 백엔드 커넥터 러너에서 검증합니다.", "브라우저는 원시 데이터베이스 소켓을 열지 않습니다."],
      assetsTitle: "PostgreSQL 테이블 탐색",
      assets: [],
      previewTitle: "데이터 미리보기",
      previewNote: "테이블을 선택하면 일부 행을 가져와 표시합니다.",
      previewColumns: ["Table", "Rows", "Status"],
      previewRows: [],
      info: "",
    },
    MongoDB: {
      title: "MongoDB 연결",
      description: "백엔드 커넥터가 MongoDB 컬렉션 목록, 문서 샘플, 중첩 필드를 조회합니다.",
      fields: [
        ["Endpoint / Host", "127.0.0.1"],
        ["Port", "27018"],
        ["Database Name", "asklake_sources"],
        ["Username", ""],
        ["Password / Auth Token", ""],
        ["DATASET OR TABLE SELECTOR", ""],
      ],
      testItems: [["Endpoint", "Not tested"], ["Database", "Pending"], ["Target discovery", "After connection"]],
      logs: ["MongoDB 소스 식별이 아직 검증되지 않았습니다.", "연결 테스트를 실행하면 제한 문서 샘플을 가져옵니다."],
      assetsTitle: "MongoDB 컬렉션 탐색",
      assets: [],
      previewTitle: "데이터 미리보기",
      previewNote: "컬렉션을 선택하면 일부 문서를 표 형태로 표시합니다.",
      previewColumns: ["Collection", "Documents", "Status"],
      previewRows: [],
      info: "",
    },
    "File / S3": {
      title: `${OBJECT_STORAGE_PROVIDER_LABEL} 연결 설정`,
      description: OBJECT_STORAGE_IS_AWS
        ? "워크스페이스 AWS 권한으로 입력한 S3 버킷을 확인하고 파일을 탐색합니다."
        : "MinIO 오브젝트 스토리지에서 버킷과 제한 샘플을 실제 조회합니다.",
      fields: [
        ["Storage Provider", OBJECT_STORAGE_PROVIDER_LABEL],
        ["Endpoint URL", ""],
        ["Region", OBJECT_STORAGE_REGION],
        ["Bucket / Stage Name", OBJECT_STORAGE_IS_AWS ? "" : sourceDefaults.s3Bucket],
        ["Path / Prefix", OBJECT_STORAGE_IS_AWS ? "" : sourceDefaults.s3Prefix],
        ["Access Key", ""],
        ["Secret Key", ""],
        ["Use Path Style", String(!OBJECT_STORAGE_IS_AWS)],
        ["File Type", "auto"],
        ["Delimiter", ","],
        ["Encoding", "UTF-8"],
        ["Header", "Treat first row as header"],
      ],
      fieldSuggestions: OBJECT_STORAGE_IS_AWS && sourceDefaults.s3Bucket
        ? { "Bucket / Stage Name": sourceDefaults.s3Bucket }
        : undefined,
      testItems: [["Endpoint", "Not tested"], ["Bucket", "Not listed"], ["샘플 프로파일", "Pending"]],
      logs: [`${OBJECT_STORAGE_PROVIDER_LABEL} 소스 식별이 아직 검증되지 않았습니다.`, "연결 테스트를 실행하면 제한 샘플을 가져옵니다."],
      assetsTitle: `${OBJECT_STORAGE_PROVIDER_LABEL} 파일 탐색`,
      assets: [],
      previewTitle: "데이터 미리보기",
      previewNote: "파일을 선택하면 일부 데이터를 가져와 표시합니다.",
      previewColumns: ["Object Key", "Size", "Last Modified"],
      previewRows: [],
      info: OBJECT_STORAGE_IS_AWS
        ? "워크스페이스에 연결된 AWS 권한으로 입력한 버킷에 접근합니다."
        : "",
    },
    "Data Lake": {
      title: "AskLake 데이터 레이크",
      description: "현재 로그인 계정으로 접근할 수 있는 AskLake 데이터셋을 선택합니다.",
      fields: [
        ["Source Dataset", ""],
        ["Source Dataset ID", ""],
      ],
      testItems: [],
      logs: ["AskLake 로그인 세션과 Catalog 권한을 기준으로 데이터셋 목록을 조회합니다."],
      assetsTitle: "AskLake 데이터셋 탐색",
      assets: [],
      previewTitle: "데이터 미리보기",
      previewNote: "왼쪽 목록에서 사용할 데이터셋을 선택하세요.",
      previewColumns: [],
      previewRows: [],
    },
    "REST API": {
      title: "REST API 소스",
      description: "원격 데이터를 수집할 REST 엔드포인트를 설정합니다.",
      fields: [
        ["Method", "GET"],
        ["Endpoint URL", "http://localhost:8080/api/harness/rest-sample"],
        ["Authentication Type", "None"],
        ["Token / Secret", ""],
        ["Accept", "application/json"],
        ["X-Request-ID", "etl-9928-ax"],
        ["limit", "50"],
        ["status", "active"],
        ["Pagination Strategy", "Page Number"],
        ["Root Path", "$.data.items"],
      ],
      testItems: [["Endpoint", "Not tested"], ["Auth", "Pending"], ["Response", "Pending"]],
      logs: ["REST 소스 식별이 아직 검증되지 않았습니다.", "연결 테스트를 실행하면 백엔드가 HTTP 응답 샘플을 가져옵니다."],
      assetsTitle: "REST API 응답 탐색",
      assets: [],
      previewTitle: "데이터 미리보기",
      previewNote: "연결을 확인하면 응답의 일부 데이터를 표시합니다.",
      previewColumns: ["User ID", "Email", "Date", "Status", "Amount"],
      previewRows: [],
    },
    "Stream / Kafka": {
      title: "스트림 소스 설정",
      description: "실시간 데이터 스트림 엔드포인트를 설정합니다.",
      fields: [
        ["Stream Type", "Apache Kafka"],
        ["Broker / Endpoint", sourceDefaults.kafkaBroker],
        ["TOPIC / QUEUE NAME", sourceDefaults.kafkaTopic],
        ["CONSUMER GROUP ID", "asklake-etl-consumer-01"],
        ["Offset Policy", "Earliest (Start from beginning)"],
        ["Message Format", "JSON (Auto-infer Schema)"],
        ["Authentication", "SASL / SCRAM"],
      ],
      testItems: [["Broker Reachable", "Not tested"], ["Topic Access", "Pending"], ["Backend connector", "Required"]],
      logs: ["Kafka 소스 윈도우 식별은 백엔드 커넥터 러너에서 검증합니다.", "브라우저는 Kafka 프로토콜 핸드셰이크를 수행할 수 없습니다."],
      assetsTitle: "Kafka 토픽 메시지 탐색",
      assets: [],
      previewTitle: "데이터 미리보기",
      previewNote: "연결을 확인하면 일부 메시지를 가져와 표시합니다.",
      previewColumns: ["Payload (Raw JSON)", "Part.", "Offset", "Timestamp"],
      previewRows: [],
    },
  };
  return { connectorMeta, sourceConfigs };
}
