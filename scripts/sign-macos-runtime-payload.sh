#!/usr/bin/env bash
set -euo pipefail

runtime_dir="${1:?usage: scripts/sign-macos-runtime-payload.sh <runtime-dir>}"
runtime_dir="${runtime_dir%/}"
identity="${APPLE_SIGNING_IDENTITY:-}"
entitlements_file="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/macos-runtime.entitlements.plist"

if [[ ! -d "$runtime_dir" ]]; then
  echo "macOS runtime payload not found: $runtime_dir" >&2
  exit 1
fi
if [[ -z "$identity" ]]; then
  echo "APPLE_SIGNING_IDENTITY is empty" >&2
  exit 1
fi

sign_args=(--force --sign "$identity" --timestamp --options runtime)

is_macho() {
  file "$1" | grep -q 'Mach-O'
}

main_binary="$runtime_dir/$(basename "$runtime_dir")"
if [[ ! -f "$main_binary" ]] || ! is_macho "$main_binary"; then
  echo "macOS runtime main executable not found: $main_binary" >&2
  exit 1
fi

echo "Signing bundled macOS runtime: $runtime_dir"
macho_count=0
while IFS= read -r -d '' path; do
  [[ "$path" == *".framework/"* ]] && continue
  if is_macho "$path"; then
    path_args=("${sign_args[@]}")
    if [[ "$path" == "$main_binary" ]]; then
      path_args+=(--entitlements "$entitlements_file")
    fi
    codesign "${path_args[@]}" "$path"
    macho_count=$((macho_count + 1))
  fi
done < <(find "$runtime_dir" -type f -print0)

framework_count=0
while IFS= read -r -d '' framework; do
  codesign "${sign_args[@]}" "$framework"
  framework_count=$((framework_count + 1))
done < <(find "$runtime_dir" -type d -name '*.framework' -print0 | sort -z -r)

if ! codesign -d --entitlements - "$main_binary" 2>/dev/null \
  | grep -q 'com.apple.security.cs.allow-unsigned-executable-memory'; then
  echo "Main runtime binary is missing required executable-memory entitlement" >&2
  exit 1
fi

echo "Signed $framework_count framework bundle(s) and $macho_count non-framework Mach-O file(s)."
