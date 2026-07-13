import { Braces, HardDrive, TerminalSquare } from "lucide-react";
import amazonS3IconUrl from "../../assets/amazons3.svg";
import apacheKafkaIconUrl from "../../assets/apachekafka.svg";
import askLakeLogoUrl from "../../assets/asklake-logo.png";
import mongoDbIconUrl from "../../assets/mongodb.svg";
import postgreSqlIconUrl from "../../assets/postgresql.svg";
import { cn } from "../../lib/utils";

export type SourceBrandKind = "generic" | "kafka" | "lake" | "mongo" | "postgres" | "rest" | "s3" | "sql";

type SourceBrandMeta = {
  kind: SourceBrandKind;
  label: string;
};

const sourceBrandAliases: Record<string, SourceBrandMeta> = {
  "amazon s3": { kind: "s3", label: "Amazon S3" },
  "apache kafka": { kind: "kafka", label: "Apache Kafka" },
  "asklake data lake": { kind: "lake", label: "AskLake 데이터 레이크" },
  "asklake 데이터 레이크": { kind: "lake", label: "AskLake 데이터 레이크" },
  "data lake": { kind: "lake", label: "AskLake 데이터 레이크" },
  "file / s3": { kind: "s3", label: "Amazon S3" },
  kafka: { kind: "kafka", label: "Apache Kafka" },
  "lake dataset": { kind: "lake", label: "AskLake 데이터 레이크" },
  minio: { kind: "s3", label: "Amazon S3" },
  mongodb: { kind: "mongo", label: "MongoDB" },
  postgresql: { kind: "postgres", label: "PostgreSQL" },
  "rest api": { kind: "rest", label: "REST API" },
  s3: { kind: "s3", label: "Amazon S3" },
  "sql result": { kind: "sql", label: "SQL Result" },
  "stream / kafka": { kind: "kafka", label: "Apache Kafka" },
};

export function getSourceBrandMeta(value: string): SourceBrandMeta {
  const normalized = value.trim().toLowerCase();
  return sourceBrandAliases[normalized] ?? {
    kind: "generic",
    label: value.trim() || "데이터 소스",
  };
}

export function SourceBrandIcon({
  className,
  kind,
  size,
}: {
  className?: string;
  kind: SourceBrandKind;
  size?: number;
}) {
  const compactStyle = size ? { height: size, width: size } : undefined;

  if (kind === "rest") {
    return (
      <span
        aria-hidden="true"
        className={cn("source-brand-icon source-brand-rest inline-flex items-center justify-center", className)}
        style={compactStyle}
      >
        <Braces size={size ? Math.max(12, size - 2) : 38} strokeWidth={2.2} />
      </span>
    );
  }

  if (kind === "lake") {
    return (
      <span
        aria-hidden="true"
        className={cn("source-brand-icon source-brand-asklake relative inline-block overflow-hidden", className)}
        style={compactStyle}
      >
        <img
          alt=""
          src={askLakeLogoUrl}
          style={size ? { height: Math.max(14, size - 1), left: 0, maxWidth: "none", position: "absolute", top: "50%", transform: "translateY(-50%)", width: "auto" } : undefined}
        />
      </span>
    );
  }

  if (kind === "sql") {
    return <TerminalSquare aria-hidden="true" className={className} size={size ?? 20} />;
  }

  if (kind === "generic") {
    return <HardDrive aria-hidden="true" className={className} size={size ?? 20} />;
  }

  const brand = {
    kafka: { color: "#231f20", url: apacheKafkaIconUrl },
    mongo: { color: "#47a248", url: mongoDbIconUrl },
    postgres: { color: "#4169e1", url: postgreSqlIconUrl },
    s3: { color: "#569a31", url: amazonS3IconUrl },
  }[kind];

  return (
    <span
      aria-hidden="true"
      className={cn(`source-brand-icon source-brand-${kind}`, className)}
      style={{
        ...compactStyle,
        backgroundColor: brand.color,
        maskImage: `url(${brand.url})`,
        maskPosition: "center",
        maskRepeat: "no-repeat",
        maskSize: "contain",
        WebkitMaskImage: `url(${brand.url})`,
        WebkitMaskPosition: "center",
        WebkitMaskRepeat: "no-repeat",
        WebkitMaskSize: "contain",
      }}
    />
  );
}
