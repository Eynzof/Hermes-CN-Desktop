; Tauri NSIS installer hooks — Hermes Agent CN Desktop
;
; A fresh Windows install keeps all of its growing data (kernel runtime,
; sessions, config, caches, WebView2) under "$INSTDIR\data" so that choosing a
; non-C: install drive actually keeps data off C: (see runtime_root() in
; src/process/runtime.rs). That folder is created at runtime and is NOT part of
; the installer's file manifest, so the uninstaller leaves it in place by
; default. On uninstall, ask whether to also remove this personal data: choosing
; "No" preserves sessions/config for a later reinstall, "Yes" wipes it clean.

!macro NSIS_HOOK_PREUNINSTALL
  ; Only prompt when there is actually data to remove.
  IfFileExists "$INSTDIR\data\*.*" 0 hermes_keep_userdata
    MessageBox MB_YESNO|MB_ICONQUESTION "是否同时删除个人数据（会话 / 配置 / 缓存）？$\r$\n位置：$INSTDIR\data" IDNO hermes_keep_userdata
    RMDir /r "$INSTDIR\data"
  hermes_keep_userdata:
!macroend
