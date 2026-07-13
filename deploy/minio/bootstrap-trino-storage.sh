#!/bin/sh
set -eu

alias_name=asklake-bootstrap
endpoint="${MINIO_ENDPOINT:-http://minio:9000}"
warehouse_bucket="${TRINO_ICEBERG_WAREHOUSE_BUCKET:-asklake-warehouse}"
result_bucket="${TRINO_RESULT_STORAGE_BUCKET:-asklake-query-results}"
warehouse_user="${TRINO_S3_ACCESS_KEY:?TRINO_S3_ACCESS_KEY is required}"
result_user="${TRINO_RESULT_STORAGE_ACCESS_KEY:?TRINO_RESULT_STORAGE_ACCESS_KEY is required}"
root_user="${MINIO_ACCESS_KEY:?MINIO_ACCESS_KEY is required}"

[ "$warehouse_bucket" != "$result_bucket" ] || {
  echo "Trino warehouse and query result buckets must be separate" >&2
  exit 1
}
[ "$warehouse_user" != "$result_user" ] && [ "$warehouse_user" != "$root_user" ] && [ "$result_user" != "$root_user" ] || {
  echo "Trino warehouse, query result, and MinIO root users must be separate" >&2
  exit 1
}

trap 'rm -f /tmp/warehouse-policy.json /tmp/result-policy.json' EXIT

mc alias set "$alias_name" "$endpoint" \
  "$root_user" \
  "${MINIO_SECRET_KEY:?MINIO_SECRET_KEY is required}"

mc mb --ignore-existing "$alias_name/$warehouse_bucket"
mc mb --ignore-existing "$alias_name/$result_bucket"

warehouse_policy="asklake-warehouse-$(printf '%s' "$warehouse_bucket" | tr -c 'a-zA-Z0-9-' '-')"
result_policy="asklake-results-$(printf '%s' "$result_bucket" | tr -c 'a-zA-Z0-9-' '-')"

cat > /tmp/warehouse-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {"Effect": "Allow", "Action": ["s3:GetBucketLocation", "s3:ListBucket"], "Resource": ["arn:aws:s3:::$warehouse_bucket"]},
    {"Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"], "Resource": ["arn:aws:s3:::$warehouse_bucket/*"]}
  ]
}
EOF

cat > /tmp/result-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {"Effect": "Allow", "Action": ["s3:GetBucketLocation", "s3:ListBucket"], "Resource": ["arn:aws:s3:::$result_bucket"]},
    {"Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"], "Resource": ["arn:aws:s3:::$result_bucket/*"]}
  ]
}
EOF

mc admin policy create "$alias_name" "$warehouse_policy" /tmp/warehouse-policy.json
mc admin policy create "$alias_name" "$result_policy" /tmp/result-policy.json

mc admin user add "$alias_name" \
  "$warehouse_user" \
  "${TRINO_S3_SECRET_KEY:?TRINO_S3_SECRET_KEY is required}"
mc admin policy attach "$alias_name" "$warehouse_policy" --user "$warehouse_user"

mc admin user add "$alias_name" \
  "$result_user" \
  "${TRINO_RESULT_STORAGE_SECRET_KEY:?TRINO_RESULT_STORAGE_SECRET_KEY is required}"
mc admin policy attach "$alias_name" "$result_policy" --user "$result_user"
