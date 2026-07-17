#!/usr/bin/env bash
# Codex CLI 的确定性 stub（P-047 委派可视化冒烟/E2E 用，零成本）。
# 模拟 `codex exec [--json] ...`：--json 输出 experimental JSONL 事件流，
# 否则输出纯文本。STUB_FAIL=1 时以退出码 1 失败。命名为 `codex` 放 PATH 用。
set -euo pipefail

JSON=0
for arg in "$@"; do
  [ "$arg" = "--json" ] && JSON=1
done

if [ "${STUB_FAIL:-0}" = "1" ]; then
  echo "stub: simulated failure" >&2
  exit 1
fi

THREAD_ID="stub-cx-${STUB_SESSION_SUFFIX:-1}"
SLEEP="${STUB_STEP_DELAY:-1}"

if [ "$JSON" = "1" ]; then
  echo '{"type":"thread.started","thread_id":"'"$THREAD_ID"'"}'
  sleep "$SLEEP"
  echo '{"type":"item.completed","item":{"type":"agent_message","text":"开始重构 auth 模块"}}'
  sleep "$SLEEP"
  echo '{"type":"item.completed","item":{"type":"command_execution","command":"cargo check","exit_code":0}}'
  sleep "$SLEEP"
  echo '{"type":"item.completed","item":{"type":"agent_message","text":"重构完成，测试通过"}}'
  sleep "$SLEEP"
  echo '{"type":"turn.completed","usage":{"input_tokens":321,"output_tokens":654}}'
else
  sleep "$SLEEP"
  echo "stub codex done"
fi
