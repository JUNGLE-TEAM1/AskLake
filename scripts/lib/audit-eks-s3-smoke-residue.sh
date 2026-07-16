#!/usr/bin/env bash

# Read tab-separated bucket/prefix pairs from stdin. AWS CLI pagination combines
# every list-object-versions page before jq evaluates the approved smoke prefix.
audit_asklake_s3_smoke_residue() {
  local region="$1"
  local residue_count=0 bucket prefix versions count
  while IFS=$'\t' read -r bucket prefix; do
    [[ -n "$bucket" && -n "$prefix" ]] || continue
    versions="$(aws s3api list-object-versions \
      --region "$region" --bucket "$bucket" --prefix "$prefix" --output json)"
    count="$(jq '[((.Versions // []) + (.DeleteMarkers // []))[] | select(.Key | startswith($prefix))] | length' \
      --arg prefix "$prefix" <<<"$versions")"
    residue_count=$((residue_count + count))
  done
  printf 'backend_s3_versioned_smoke_residue=%d\n' "$residue_count"
  [[ "$residue_count" -eq 0 ]] || {
    echo "versioned Backend S3 smoke residue remains" >&2
    return 1
  }
}
