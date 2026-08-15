use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FatalErrorInput {
    pub title: String,
    pub message: String,
}

/// Show a modal fatal-error message and exit the application.
///
/// Called from the renderer when a hard invariant (e.g. backend version
/// mismatch) is detected. We show the dialog synchronously on a blocking
/// thread, then exit with a non-zero code.
#[tauri::command]
pub async fn fatal_error_and_exit(app: AppHandle, input: FatalErrorInput) {
    let title = input.title;
    let message = input.message;
    let app_for_dialog = app.clone();
    let dialog_result = tauri::async_runtime::spawn_blocking(move || {
        app_for_dialog
            .dialog()
            .message(message)
            .title(title)
            .show(|_| {});
    })
    .await;
    if let Err(err) = dialog_result {
        log::error!("fatal_error_and_exit dialog failed: {}", err);
    }
    app.exit(1);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fatal_error_input_deserializes_from_camelcase_json() {
        let input: FatalErrorInput =
            serde_json::from_str(r#"{"title":"版本不匹配","message":"请升级桌面端"}"#)
                .expect("must deserialize");
        assert_eq!(input.title, "版本不匹配");
        assert_eq!(input.message, "请升级桌面端");
    }
}
