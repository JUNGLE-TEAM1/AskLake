#!/usr/bin/env bash

asklake_cleanup_backend_secret_stage() {
  local stage_name="$1" namespace="$2" failed=0
  kubectl delete externalsecret "$stage_name" -n "$namespace" --ignore-not-found --wait=true >/dev/null 2>&1 || failed=1
  kubectl delete secret "$stage_name" -n "$namespace" --ignore-not-found --wait=true >/dev/null 2>&1 || failed=1
  [[ "$failed" -eq 0 ]]
}

asklake_restore_backend_manual_secret() {
  local root_dir="$1" name="$2" namespace="$3" source_json="$4"
  local restored_secret restored_hash source_hash deployment
  [[ -n "$source_json" ]] || return 0
  kubectl delete externalsecret "$name" -n "$namespace" --ignore-not-found --wait=true >/dev/null || return 1
  kubectl delete secret "$name" -n "$namespace" --ignore-not-found --wait=true >/dev/null || return 1
  jq \
    --arg namespace "$namespace" \
    --arg name "$name" '
      {apiVersion:"v1",kind:"Secret",metadata:{name:$name,namespace:$namespace},type:"Opaque",stringData:{DATABASE_URL:.DATABASE_URL,BOOTSTRAP_ADMIN_PASSWORD:.BOOTSTRAP_ADMIN_PASSWORD}}
    ' <<<"$source_json" | kubectl apply -f - >/dev/null || return 1
  restored_secret="$(kubectl get secret "$name" -n "$namespace" -o json)" || return 1
  jq -e '
    .type == "Opaque"
    and (.data | keys | sort) == ["BOOTSTRAP_ADMIN_PASSWORD", "DATABASE_URL"]
    and ((.metadata.ownerReferences // []) | length == 0)
  ' <<<"$restored_secret" >/dev/null || return 1
  restored_hash="$(jq -S -c '.data | with_entries(.value |= @base64d) | {BOOTSTRAP_ADMIN_PASSWORD,DATABASE_URL}' <<<"$restored_secret" | asklake_sha256)" || return 1
  source_hash="$(jq -S -c '{BOOTSTRAP_ADMIN_PASSWORD,DATABASE_URL}' <<<"$source_json" | asklake_sha256)" || return 1
  [[ "$restored_hash" == "$source_hash" ]] || return 1
  unset restored_secret restored_hash source_hash
  kubectl rollout restart deployment/fastapi -n "$namespace" >/dev/null || return 1
  kubectl rollout status deployment/fastapi -n "$namespace" --timeout=5m >/dev/null || return 1
  deployment="$(kubectl get deployment fastapi -n "$namespace" -o json)" || return 1
  jq -e '
    (.spec.replicas // 0) == 2
    and (.status.readyReplicas // 0) == 2
    and (.status.updatedReplicas // 0) == 2
    and (.status.availableReplicas // 0) == 2
    and (.status.unavailableReplicas // 0) == 0
  ' <<<"$deployment" >/dev/null || return 1
  bash "$root_dir/scripts/verify-eks-day15-alb-runtime.sh" --steady >/dev/null || return 1
}
