// Session archive state management.
//
// Replaces the archive logic in hermes-cn-ui-v1/apps/desktop/src/main/main.ts
// lines 289-411. Manages local UI state that tracks which sessions are
// "archived" (hidden from the session list but not deleted from the backend).

use std::collections::HashSet;
use std::sync::LazyLock;

use crate::ui_store;

static ARCHIVE_ROUTE_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"^/api/sessions/([^/]+)/archive$").expect("valid archive route regex")
});

#[cfg(test)]
fn normalize_ids(ids: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    ids.iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && seen.insert(s.clone()))
        .collect()
}

pub fn read_archive_state(hermes_home: &str) -> HashSet<String> {
    ui_store::read_archived_session_ids(hermes_home)
}

pub fn write_archive_state(hermes_home: &str, ids: &HashSet<String>) -> Result<(), String> {
    let current = ui_store::read_archived_session_ids(hermes_home);
    for id in current.difference(ids) {
        ui_store::set_session_archived(hermes_home, id, false).map_err(|e| e.to_string())?;
    }
    for id in ids {
        ui_store::set_session_archived(hermes_home, id, true).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Check if a path matches /api/sessions/{id}/archive and extract the session ID.
pub fn extract_archive_session_id(path: &str) -> Option<String> {
    let url_path = if let Ok(url) = url::Url::parse(&format!("http://x{}", path)) {
        url.path().to_string()
    } else {
        path.to_string()
    };
    let caps = ARCHIVE_ROUTE_RE.captures(&url_path)?;
    let raw = caps.get(1)?.as_str().to_string();
    let decoded = urlencoding::decode(&raw).ok()?.into_owned();
    let trimmed = decoded.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

/// Handle a POST/PUT/DELETE request to /api/sessions/{id}/archive.
/// Returns a JSON response body, or None if the path doesn't match.
pub fn handle_archive_request(
    path: &str,
    method: &str,
    hermes_home: &str,
) -> Option<(u16, serde_json::Value)> {
    let session_id = extract_archive_session_id(path)?;
    let upper = method.to_uppercase();

    if !["POST", "PUT", "DELETE"].contains(&upper.as_str()) {
        return Some((405, serde_json::json!({ "message": "method not allowed" })));
    }

    let mut archived = read_archive_state(hermes_home);
    if upper == "DELETE" {
        archived.remove(&session_id);
    } else {
        archived.insert(session_id.clone());
    }

    if let Err(e) = write_archive_state(hermes_home, &archived) {
        return Some((500, serde_json::json!({ "error": e })));
    }

    Some((
        200,
        serde_json::json!({
            "ok": true,
            "session_id": session_id,
            "archived": upper != "DELETE",
        }),
    ))
}

/// Filter archived sessions from a /api/sessions or /api/sessions/search response.
pub fn filter_archived_from_response(
    path: &str,
    method: &str,
    hermes_home: &str,
    body: &str,
) -> String {
    if method.to_uppercase() != "GET" {
        return body.to_string();
    }

    let url_path = if let Ok(url) = url::Url::parse(&format!("http://x{}", path)) {
        // Check for include_archived=true query param
        if url
            .query_pairs()
            .any(|(k, v)| k == "include_archived" && v == "true")
        {
            return body.to_string();
        }
        url.path().to_string()
    } else {
        return body.to_string();
    };

    let is_sessions = url_path == "/api/sessions";
    let is_search = url_path == "/api/sessions/search";
    if !is_sessions && !is_search {
        return body.to_string();
    }

    let archived = read_archive_state(hermes_home);
    if archived.is_empty() {
        return body.to_string();
    }

    let mut data: serde_json::Value = match serde_json::from_str(body) {
        Ok(d) => d,
        Err(_) => return body.to_string(),
    };

    if is_sessions {
        if let Some(sessions) = data.get_mut("sessions").and_then(|s| s.as_array_mut()) {
            let before = sessions.len();
            sessions.retain(|s| {
                s.get("id")
                    .and_then(|id| id.as_str())
                    .map(|id| !archived.contains(id))
                    .unwrap_or(true)
            });
            let removed = before - sessions.len();
            if removed > 0 {
                if let Some(total) = data.get_mut("total").and_then(|t| t.as_i64()) {
                    data["total"] = serde_json::json!(std::cmp::max(0, total - removed as i64));
                }
            }
        }
    }

    if is_search {
        if let Some(results) = data.get_mut("results").and_then(|r| r.as_array_mut()) {
            results.retain(|r| {
                r.get("session_id")
                    .and_then(|id| id.as_str())
                    .map(|id| !archived.contains(id))
                    .unwrap_or(true)
            });
        }
    }

    serde_json::to_string(&data).unwrap_or_else(|_| body.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use tempfile::TempDir;

    fn home_str(dir: &TempDir) -> &str {
        dir.path().to_str().unwrap()
    }

    // -------- normalize_ids --------

    #[test]
    fn normalize_dedups_and_trims() {
        let input = vec![
            "  a  ".to_string(),
            "b".to_string(),
            "a".to_string(),
            "".to_string(),
            "   ".to_string(),
            "b".to_string(),
        ];
        assert_eq!(
            normalize_ids(&input),
            vec!["a".to_string(), "b".to_string()]
        );
    }

    #[test]
    fn normalize_preserves_first_occurrence_order() {
        let input = vec!["z".to_string(), "a".to_string(), "z".to_string()];
        assert_eq!(
            normalize_ids(&input),
            vec!["z".to_string(), "a".to_string()]
        );
    }

    // -------- extract_archive_session_id --------

    #[test]
    fn extract_matches_canonical_path() {
        assert_eq!(
            extract_archive_session_id("/api/sessions/abc123/archive"),
            Some("abc123".to_string())
        );
    }

    #[test]
    fn extract_matches_with_query_string() {
        assert_eq!(
            extract_archive_session_id("/api/sessions/abc123/archive?force=true"),
            Some("abc123".to_string())
        );
    }

    #[test]
    fn extract_decodes_url_encoded_id() {
        assert_eq!(
            extract_archive_session_id("/api/sessions/abc%20def/archive"),
            Some("abc def".to_string())
        );
    }

    #[test]
    fn extract_rejects_non_archive_paths() {
        assert_eq!(extract_archive_session_id("/api/sessions"), None);
        assert_eq!(extract_archive_session_id("/api/sessions/abc"), None);
        assert_eq!(
            extract_archive_session_id("/api/sessions/abc/archive/extra"),
            None
        );
    }

    #[test]
    fn extract_rejects_empty_id() {
        // The regex requires a non-empty session segment; double slash matches
        // nothing because [^/]+ won't consume an empty path component.
        assert_eq!(extract_archive_session_id("/api/sessions//archive"), None);
    }

    // -------- read / write archive state --------

    #[test]
    fn read_archive_state_empty_when_no_ui_store_rows() {
        let dir = TempDir::new().unwrap();
        let state = read_archive_state(home_str(&dir));
        assert!(state.is_empty());
    }

    #[test]
    fn write_then_read_roundtrip() {
        let dir = TempDir::new().unwrap();
        let mut ids = HashSet::new();
        ids.insert("a".to_string());
        ids.insert("b".to_string());

        write_archive_state(home_str(&dir), &ids).unwrap();
        let restored = read_archive_state(home_str(&dir));
        assert_eq!(restored, ids);
    }

    #[test]
    fn read_archive_state_recovers_from_missing_ui_store() {
        let dir = TempDir::new().unwrap();
        let state = read_archive_state(home_str(&dir));
        assert!(state.is_empty());
    }

    #[test]
    fn write_creates_directory_if_missing() {
        let dir = TempDir::new().unwrap();
        let nested = dir.path().join("nested");
        let nested_str = nested.to_str().unwrap();
        let mut ids = HashSet::new();
        ids.insert("x".to_string());
        write_archive_state(nested_str, &ids).unwrap();
        assert_eq!(read_archive_state(nested_str), ids);
    }

    // -------- handle_archive_request --------

    #[test]
    fn handle_post_adds_session_to_state() {
        let dir = TempDir::new().unwrap();
        let (status, body) =
            handle_archive_request("/api/sessions/s1/archive", "POST", home_str(&dir))
                .expect("matching path returns Some");
        assert_eq!(status, 200);
        assert_eq!(body["session_id"], "s1");
        assert_eq!(body["archived"], true);
        assert!(read_archive_state(home_str(&dir)).contains("s1"));
    }

    #[test]
    fn handle_put_adds_session_to_state() {
        let dir = TempDir::new().unwrap();
        let (status, body) =
            handle_archive_request("/api/sessions/s1/archive", "PUT", home_str(&dir))
                .expect("matching path returns Some");
        assert_eq!(status, 200);
        assert_eq!(body["archived"], true);
    }

    #[test]
    fn handle_delete_removes_session_from_state() {
        let dir = TempDir::new().unwrap();
        let mut existing = HashSet::new();
        existing.insert("s1".to_string());
        write_archive_state(home_str(&dir), &existing).unwrap();

        let (status, body) =
            handle_archive_request("/api/sessions/s1/archive", "DELETE", home_str(&dir))
                .expect("matching path returns Some");
        assert_eq!(status, 200);
        assert_eq!(body["archived"], false);
        assert!(!read_archive_state(home_str(&dir)).contains("s1"));
    }

    #[test]
    fn handle_get_returns_405_method_not_allowed() {
        let dir = TempDir::new().unwrap();
        let (status, _) = handle_archive_request("/api/sessions/s1/archive", "GET", home_str(&dir))
            .expect("matching path returns Some");
        assert_eq!(status, 405);
    }

    #[test]
    fn handle_non_matching_path_returns_none() {
        let dir = TempDir::new().unwrap();
        assert!(handle_archive_request("/api/sessions", "POST", home_str(&dir)).is_none());
        assert!(handle_archive_request("/api/other", "POST", home_str(&dir)).is_none());
    }

    // -------- filter_archived_from_response --------

    fn sessions_body() -> String {
        serde_json::json!({
            "sessions": [
                {"id": "s1", "name": "alpha"},
                {"id": "s2", "name": "beta"},
                {"id": "s3", "name": "gamma"},
            ],
            "total": 3,
        })
        .to_string()
    }

    fn search_body() -> String {
        serde_json::json!({
            "results": [
                {"session_id": "s1", "snippet": "a"},
                {"session_id": "s2", "snippet": "b"},
            ],
        })
        .to_string()
    }

    fn archive(home: &str, ids: &[&str]) {
        let set: HashSet<String> = ids.iter().map(|s| s.to_string()).collect();
        write_archive_state(home, &set).unwrap();
    }

    #[test]
    fn filter_removes_archived_from_sessions_response() {
        let dir = TempDir::new().unwrap();
        archive(home_str(&dir), &["s2"]);
        let out =
            filter_archived_from_response("/api/sessions", "GET", home_str(&dir), &sessions_body());
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        let ids: Vec<&str> = v["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["s1", "s3"]);
        assert_eq!(v["total"], 2);
    }

    #[test]
    fn filter_removes_archived_from_search_response() {
        let dir = TempDir::new().unwrap();
        archive(home_str(&dir), &["s1"]);
        let out = filter_archived_from_response(
            "/api/sessions/search",
            "GET",
            home_str(&dir),
            &search_body(),
        );
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        let ids: Vec<&str> = v["results"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["session_id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["s2"]);
    }

    #[test]
    fn filter_passes_through_for_non_get() {
        let dir = TempDir::new().unwrap();
        archive(home_str(&dir), &["s1"]);
        let body = sessions_body();
        let out = filter_archived_from_response("/api/sessions", "POST", home_str(&dir), &body);
        assert_eq!(out, body);
    }

    #[test]
    fn filter_passes_through_when_include_archived_set() {
        let dir = TempDir::new().unwrap();
        archive(home_str(&dir), &["s1"]);
        let body = sessions_body();
        let out = filter_archived_from_response(
            "/api/sessions?include_archived=true",
            "GET",
            home_str(&dir),
            &body,
        );
        assert_eq!(out, body);
    }

    #[test]
    fn filter_passes_through_when_archive_set_empty() {
        let dir = TempDir::new().unwrap();
        let body = sessions_body();
        let out = filter_archived_from_response("/api/sessions", "GET", home_str(&dir), &body);
        assert_eq!(out, body);
    }

    #[test]
    fn filter_passes_through_malformed_body() {
        let dir = TempDir::new().unwrap();
        archive(home_str(&dir), &["s1"]);
        let body = "{not valid json";
        let out = filter_archived_from_response("/api/sessions", "GET", home_str(&dir), body);
        assert_eq!(out, body);
    }

    #[test]
    fn filter_passes_through_unrelated_path() {
        let dir = TempDir::new().unwrap();
        archive(home_str(&dir), &["s1"]);
        let body = "{}";
        let out = filter_archived_from_response("/api/other", "GET", home_str(&dir), body);
        assert_eq!(out, body);
    }
}
