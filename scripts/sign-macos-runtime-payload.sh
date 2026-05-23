#!/usr/bin/env bash
set -euo pipefail

runtime_dir="${1:-static/bundled-runtime/hermes-agent-cn-runtime-darwin-arm64}"
identity="${APPLE_SIGNING_IDENTITY:-}"

if [[ ! -d "$runtime_dir" ]]; then
  echo "Bundled macOS runtime payload not found: $runtime_dir" >&2
  exit 1
fi

if [[ -z "$identity" ]]; then
  identity="$(
    security find-identity -v -p codesigning 2>/dev/null \
      | sed -n 's/.*"\(Developer ID Application:[^"]*\)".*/\1/p' \
      | head -n 1
  )"
fi

if [[ -z "$identity" ]]; then
  echo "APPLE_SIGNING_IDENTITY is empty and no Developer ID Application identity was found" >&2
  exit 1
fi

sign_args=(--force --sign "$identity")
if [[ "$identity" != "-" ]]; then
  sign_args+=(--timestamp --options runtime)
fi

is_macho() {
  file "$1" | grep -q 'Mach-O'
}

echo "Signing bundled macOS runtime payload with identity: $identity"
echo "Runtime payload: $runtime_dir"

macho_count=0
while IFS= read -r -d '' path; do
  case "$path" in
    *.framework/*) continue ;;
  esac
  if is_macho "$path"; then
    codesign "${sign_args[@]}" "$path"
    macho_count=$((macho_count + 1))
  fi
done < <(find "$runtime_dir" -type f -print0)

framework_count=0
while IFS= read -r -d '' framework; do
  codesign "${sign_args[@]}" --deep "$framework"
  framework_count=$((framework_count + 1))
done < <(find "$runtime_dir" -type d -name '*.framework' -print0)

echo "Signed $macho_count Mach-O files and $framework_count framework bundles."

while IFS= read -r -d '' path; do
  case "$path" in
    *.framework/*) continue ;;
  esac
  if is_macho "$path"; then
    codesign --verify --strict --verbose=2 "$path"
  fi
done < <(find "$runtime_dir" -type f -print0)

while IFS= read -r -d '' framework; do
  codesign --verify --deep --strict --verbose=2 "$framework"
done < <(find "$runtime_dir" -type d -name '*.framework' -print0)

echo "Bundled macOS runtime payload signing verification passed."
