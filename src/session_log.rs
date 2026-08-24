// Session log file reading.
//
// Replaces the /__hermes_session_log/ route handler in
// hermes-cn-ui-v1/apps/desktop/src/main/main.ts lines 507-529.
//
// Returns a `MessagesResponse`-shaped JSON body (`{ session_id, messages,
// ui_messages? }`) so the Tauri shell satisfies the UI's existing
// `MessagesResponse.parse` (see web/src/hooks/use-sessions.ts), matching the
// browser-dev `sessionLogHandler` behavior. The transform lives in
// `crate::schema::session_log::session_log_to_messages`.

use std::fs;
use std::path::Path;

use crate::schema::session_log::session_log_to_messages;

/// Read a session log file and return `(status_code, json_body)`.
///
/// On 200 the body is a `MessagesResponse`-compatible JSON object.
pub fn handle_session_log_request(session_id: &str, hermes_home: &str) -> (u16, serde_json::Value) {
    // Validate session ID (alphanumeric + underscore + dash only)
    if !session_id
        .chars()
        .all(|c| c.is_alphanumeric() || c == '_' || c == '-')
    {
        return (400, serde_json::json!({ "message": "invalid session id" }));
    }

    let log_path = Path::new(hermes_home)
        .join("sessions")
        .join(format!("session_{}.json", session_id));

    match fs::read_to_string(&log_path) {
        Ok(content) => match serde_json::from_str::<serde_json::Value>(&content) {
            Ok(log_data) => {
                let response = session_log_to_messages(session_id, &log_data);
                let body = serde_json::to_value(response).unwrap_or_else(|_| serde_json::json!({}));
                (200, body)
            }
            Err(_) => (
                500,
                serde_json::json!({ "message": "failed to parse session log" }),
            ),
        },
        Err(_) => (
            404,
            serde_json::json!({ "message": "session log not found" }),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use std::fs;
    use tempfile::TempDir;

    fn write_session_log(home: &Path, id: &str, content: &str) {
        let sessions = home.join("sessions");
        fs::create_dir_all(&sessions).unwrap();
        fs::write(sessions.join(format!("session_{}.json", id)), content).unwrap();
    }

    #[test]
    fn valid_id_with_existing_file_returns_200_messages_response() {
        let dir = TempDir::new().unwrap();
        write_session_log(
            dir.path(),
            "abc123",
            r#"{"session_start":"2024-01-01T00:00:00Z","messages":[{"role":"user","content":"hi"}]}"#,
        );

        let (status, body) = handle_session_log_request("abc123", dir.path().to_str().unwrap());

        assert_eq!(status, 200);
        assert_eq!(body["session_id"], "abc123");
        assert_eq!(body["messages"][0]["role"], "user");
        assert_eq!(body["messages"][0]["content"], "hi");
        assert!(body.get("raw_log").is_none());
    }

    #[test]
    fn valid_id_missing_file_returns_404() {
        let dir = TempDir::new().unwrap();
        let (status, body) = handle_session_log_request("missing", dir.path().to_str().unwrap());
        assert_eq!(status, 404);
        assert_eq!(body["message"], "session log not found");
    }

    #[test]
    fn path_traversal_id_returns_400() {
        let dir = TempDir::new().unwrap();
        let (status, body) =
            handle_session_log_request("../etc/passwd", dir.path().to_str().unwrap());
        assert_eq!(status, 400);
        assert_eq!(body["message"], "invalid session id");
    }

    #[test]
    fn shell_injection_id_returns_400() {
        let dir = TempDir::new().unwrap();
        let (status, _) = handle_session_log_request("id; rm -rf /", dir.path().to_str().unwrap());
        assert_eq!(status, 400);
    }

    #[test]
    fn whitespace_in_id_returns_400() {
        let dir = TempDir::new().unwrap();
        let (status, _) = handle_session_log_request("hello world", dir.path().to_str().unwrap());
        assert_eq!(status, 400);
    }

    #[test]
    fn dot_in_id_returns_400() {
        // Dot is not in the allow-list — blocks `..` escape attempts implicitly.
        let dir = TempDir::new().unwrap();
        let (status, _) = handle_session_log_request("a.b.c", dir.path().to_str().unwrap());
        assert_eq!(status, 400);
    }

    #[test]
    fn malformed_json_returns_500() {
        let dir = TempDir::new().unwrap();
        write_session_log(dir.path(), "broken", "{not valid json");
        let (status, body) = handle_session_log_request("broken", dir.path().to_str().unwrap());
        assert_eq!(status, 500);
        assert_eq!(body["message"], "failed to parse session log");
    }

    #[test]
    fn underscore_and_dash_ids_accepted() {
        let dir = TempDir::new().unwrap();
        write_session_log(dir.path(), "a_b-c", r#"{"messages":[]}"#);
        let (status, _) = handle_session_log_request("a_b-c", dir.path().to_str().unwrap());
        assert_eq!(status, 200);
    }
}
