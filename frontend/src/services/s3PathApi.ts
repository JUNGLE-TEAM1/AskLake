import { apiClient } from "./apiClient";

export type S3PrefixFolder = {
  name: string;
  prefix: string;
  type: "folder";
};

export type S3PrefixFile = {
  key: string;
  name: string;
  type: "file";
};

export type S3BucketsResponse = {
  buckets: string[];
};

export type S3PrefixesResponse = {
  bucket: string;
  files: S3PrefixFile[];
  folders: S3PrefixFolder[];
  nextContinuationToken: string | null;
  prefix: string;
};

export async function listS3Buckets() {
  return apiClient.get<S3BucketsResponse>("/api/s3/buckets");
}

export async function listS3Prefixes({
  bucket,
  continuationToken,
  prefix,
}: {
  bucket: string;
  continuationToken?: string | null;
  prefix: string;
}) {
  const query = new URLSearchParams({ bucket, prefix });
  if (continuationToken) query.set("continuationToken", continuationToken);
  return apiClient.get<S3PrefixesResponse>(`/api/s3/prefixes?${query.toString()}`);
}
