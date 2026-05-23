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

is_relocated_framework_payload_path() {
  [[ "$1" == *".framework.payload/"* ]]
}

with_plain_macho_path() {
  local source_path="$1"
  local action="$2"
  local temp_dir
  local temp_path
  local rc=0

  temp_dir="$(mktemp -d)"
  temp_path="$temp_dir/macho"
  cp -p "$source_path" "$temp_path"

  case "$action" in
    sign)
      codesign "${sign_args[@]}" "$temp_path" || rc=$?
      if [[ "$rc" -eq 0 ]]; then
        cp -p "$temp_path" "$source_path" || rc=$?
      fi
      ;;
    verify)
      codesign --verify --strict --verbose=2 "$temp_path" || rc=$?
      ;;
    *)
      echo "unknown Mach-O action: $action" >&2
      rc=1
      ;;
  esac

  rm -rf "$temp_dir"
  return "$rc"
}

sign_macho() {
  local path="$1"
  if is_relocated_framework_payload_path "$path"; then
    # codesign still applies framework bundle heuristics to paths containing
    # ".framework.", even after staging renamed PyInstaller's nonstandard
    # Python.framework to Python.framework.payload. Sign the raw Mach-O bytes
    # from a neutral temporary path, then copy the signed binary back.
    with_plain_macho_path "$path" sign
  else
    codesign "${sign_args[@]}" "$path"
  fi
}

verify_macho() {
  local path="$1"
  if is_relocated_framework_payload_path "$path"; then
    with_plain_macho_path "$path" verify
  else
    codesign --verify --strict --verbose=2 "$path"
  fi
}

echo "Signing bundled macOS runtime payload with identity: $identity"
echo "Runtime payload: $runtime_dir"

macho_count=0
while IFS= read -r -d '' path; do
  if is_macho "$path"; then
    sign_macho "$path"
    macho_count=$((macho_count + 1))
  fi
done < <(find "$runtime_dir" -type f -print0)

echo "Signed $macho_count Mach-O files."

while IFS= read -r -d '' path; do
  if is_macho "$path"; then
    verify_macho "$path"
  fi
done < <(find "$runtime_dir" -type f -print0)

echo "Bundled macOS runtime payload signing verification passed."
