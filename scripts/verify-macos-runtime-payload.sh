#!/usr/bin/env bash
set -euo pipefail

payload="${1:-static/bundled-runtime/hermes-agent-cn-runtime-darwin-arm64.zip}"
tmp_dir=""

cleanup() {
  if [[ -n "$tmp_dir" ]]; then
    rm -rf "$tmp_dir"
  fi
}
trap cleanup EXIT

if [[ -f "$payload" ]]; then
  tmp_dir="$(mktemp -d)"
  unzip -q "$payload" -d "$tmp_dir"
  runtime_dir="$tmp_dir/hermes-agent-cn-runtime-darwin-arm64"
elif [[ -d "$payload" ]]; then
  runtime_dir="$payload"
else
  echo "Bundled macOS runtime payload not found: $payload" >&2
  exit 1
fi

if [[ ! -d "$runtime_dir" ]]; then
  echo "Bundled macOS runtime root not found after extraction: $runtime_dir" >&2
  exit 1
fi

if find "$runtime_dir" -type d -name '*__hermes_framework_payload' -print -quit | grep -q .; then
  echo "Relocated macOS framework payloads are no longer allowed in bundled runtime resources." >&2
  exit 1
fi

is_macho() {
  file "$1" | grep -q 'Mach-O'
}

verify_signature() {
  local path="$1"
  codesign --verify --strict "$path"
}

echo "Verifying bundled macOS runtime payload signatures."
echo "Runtime payload: $payload"

framework_count=0
while IFS= read -r -d '' framework; do
  verify_signature "$framework"
  framework_count=$((framework_count + 1))
done < <(find "$runtime_dir" -type d -name '*.framework' -print0)

macho_count=0
while IFS= read -r -d '' path; do
  if is_macho "$path"; then
    verify_signature "$path"
    macho_count=$((macho_count + 1))
  fi
done < <(find "$runtime_dir" -type f -print0)

if [[ "$framework_count" -eq 0 ]]; then
  echo "No framework bundle found in bundled macOS runtime payload." >&2
  exit 1
fi

if [[ "$macho_count" -eq 0 ]]; then
  echo "No Mach-O file found in bundled macOS runtime payload." >&2
  exit 1
fi

echo "Verified $framework_count framework bundle(s) and $macho_count Mach-O file(s)."
