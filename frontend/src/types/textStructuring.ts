export type TextStructuringTask =
  | "copy"
  | "classification"
  | "multi_label"
  | "ordinal"
  | "boolean"
  | "extract_span"
  | "extract_scalar"
  | "free_text";

export type TextStructuringLabel = {
  value: string;
  description?: string;
  order?: number;
};

export type TextStructuringField = {
  fieldId: string;
  targetName: string;
  task: TextStructuringTask;
  description: string;
  outputType: string;
  sourceField?: string;
  allowedValues: TextStructuringLabel[];
  nullable: boolean;
  unknownValue?: string;
  evidenceRequired?: boolean;
};

export type TextStructuringRepeatedGroup = {
  groupId: string;
  targetName: string;
  description: string;
  outputMode: "nested" | "child_table";
  fields: TextStructuringField[];
};

export type TextStructuringRoutingPolicy = {
  mode: "heuristic" | "openai_compatible" | "student" | "hybrid";
  provider: "heuristic" | "openai_compatible" | "student" | "hybrid";
  acceptThreshold: number;
  humanReviewThreshold: number;
  maxLlmFraction: number;
  externalProviderAllowed: boolean;
  piiMode: "none" | "mask" | "block_external";
  onError: "fail" | "quarantine" | "keep_raw";
  batchSize: number;
};

export type TextStructuringDefinition = {
  sourceFields: string[];
  locale: string;
  outputMode: "flat" | "nested" | "child_table";
  fields: TextStructuringField[];
  repeatedGroups: TextStructuringRepeatedGroup[];
  routingPolicy: TextStructuringRoutingPolicy;
};

export type TextStructuringSpecRef = {
  specId: string;
  version: number;
  fingerprint: string;
};

export type TextStructuringResultRow = {
  sourceRowId: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  repeatedGroups: Record<string, Array<Record<string, unknown>>>;
  reviewRequired: boolean;
  reviewReasons: string[];
  route: string;
};

export type TextStructuringDraft = {
  definition?: TextStructuringDefinition;
  enabled: boolean;
  previewRows: TextStructuringResultRow[];
  specName: string;
  specRef?: TextStructuringSpecRef;
  status: "idle" | "suggested" | "previewed" | "published";
  warnings: string[];
};

export type TextStructuringSpecVersion = TextStructuringSpecRef & {
  status: "draft" | "published" | "archived";
  definition: TextStructuringDefinition;
  compiledSchema: Record<string, unknown>;
  promptVersion: string;
  createdAt: string;
  publishedAt?: string;
};

export type TextStructuringSpec = {
  id: string;
  name: string;
  description: string;
  owner: string;
  status: "draft" | "published" | "archived";
  activeVersion?: number;
  versions: TextStructuringSpecVersion[];
};
