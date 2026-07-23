#!/usr/bin/env bash

asklake_require_image_receipt() {
  local root_dir="$1"
  local configured="${2:-${ASKLAKE_IMAGE_RECEIPT:-}}"
  local receipt

  if [[ -z "$configured" ]]; then
    echo "set ASKLAKE_IMAGE_RECEIPT to the current private formal image receipt" >&2
    return 1
  fi
  case "$configured" in
    /*) receipt="$configured" ;;
    *) receipt="$root_dir/$configured" ;;
  esac
  [[ -s "$receipt" ]] || {
    echo "current private formal image receipt is missing" >&2
    return 1
  }
  git -C "$root_dir" check-ignore -q -- "$receipt" || {
    echo "private image receipt must remain ignored by Git" >&2
    return 1
  }
  if git -C "$root_dir" ls-files --error-unmatch -- "$receipt" >/dev/null 2>&1; then
    echo "private image receipt must not be tracked" >&2
    return 1
  fi
  [[ "$(stat -f '%Lp' "$receipt")" == "600" ]] || {
    echo "private image receipt must use mode 0600" >&2
    return 1
  }
  node "$root_dir/scripts/verify-eks-image-receipt.mjs" "$receipt" >/dev/null || {
    echo "private image receipt failed formal verification" >&2
    return 1
  }
  printf '%s\n' "$receipt"
}
