#!/usr/bin/env bash

verify_asklake_backend_rollout_boundary() {
  local root_dir="$1"
  local boundary_output boundary

  boundary_output="$(bash "$root_dir/scripts/verify-eks-continuous-process-boundary.sh")" || return 1
  boundary="$(awk -F= '$1 == "eks_continuous_control_plane" {print $2}' <<<"$boundary_output")"
  case "$boundary" in
    external_ec2)
      bash "$root_dir/scripts/verify-eks-external-ec2-instance.sh" >/dev/null || return 1
      ;;
    realtime_v1_only)
      ;;
    *)
      echo "Backend rollout received an unsupported Continuous boundary" >&2
      return 1
      ;;
  esac

  printf 'backend_rollout_continuous_boundary=%s\n' "$boundary"
}
