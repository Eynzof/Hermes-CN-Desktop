#!/usr/bin/env bash
# Claude Code CLI 的确定性 stub（P-047 委派可视化冒烟/E2E 用，零成本）。
# 只模拟 `claude -p ... --output-format stream-json|json` 的输出形态；
# STUB_FAIL=1 时以退出码 1 失败。放到 PATH 前部并命名为 `claude` 使用：
#   ln -s .../fake-claude.sh "$STUB_BIN/claude"
set -euo pipefail

FORMAT="text"
prev=""
for arg in "$@"; do
  if [ "$prev" = "--output-format" ]; then FORMAT="$arg"; fi
  prev="$arg"
done

if [ "${STUB_FAIL:-0}" = "1" ]; then
  echo "stub: simulated failure" >&2
  exit 1
fi

SESSION_ID="stub-cc-${STUB_SESSION_SUFFIX:-1}"
SLEEP="${STUB_STEP_DELAY:-1}"

case "$FORMAT" in
  stream-json)
    echo '{"type":"system","subtype":"init","session_id":"'"$SESSION_ID"'","model":"stub-opus"}'
    sleep "$SLEEP"
    echo '{"type":"assistant","message":{"content":[{"type":"text","text":"正在分析仓库结构"}]}}'
    sleep "$SLEEP"
    echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls src"}}]}}'
    sleep "$SLEEP"
    echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"src/app.ts"}}]}}'
    sleep "$SLEEP"
    echo '{"type":"assistant","message":{"content":[{"type":"text","text":"修改完成，正在自检"}]}}'
    sleep "$SLEEP"
    echo '{"type":"result","subtype":"success","is_error":false,"session_id":"'"$SESSION_ID"'","num_turns":3,"total_cost_usd":0.0123,"duration_ms":5000,"result":"stub done"}'
    ;;
  json)
    sleep "$SLEEP"
    echo '{"type":"result","subtype":"success","is_error":false,"session_id":"'"$SESSION_ID"'","num_turns":2,"total_cost_usd":0.0045,"duration_ms":1000,"result":"stub done"}'
    ;;
  *)
    sleep "$SLEEP"
    echo "stub claude done"
    ;;
esac
