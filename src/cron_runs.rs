//! Local cron run history reader for the desktop shell.
//!
//! The upstream dashboard currently exposes cron job CRUD, but not a run-history
//! endpoint. Cron output files are persisted under
//! `{HERMES_HOME}/cron/output/{job_id}/{timestamp}.md`, so the desktop proxy
//! serves a small read-only API for the renderer.

use regex::Regex;
use serde_json::{json, Value};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

const ROUTE_PREFIX: &str = "/__hermes_cron_runs/";
const DEFAULT_LIMIT: usize = 30;
const MAX_LIMIT: usize = 100;
const LIST_PREVIEW_BYTES: u64 = 64 * 1024;
const DETAIL_MAX_BYTES: u64 = 2 * 1024 * 1024;

static PROFILE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$").expect("valid profile regex"));
static JOB_ID_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]{1,128}$").expect("valid job id regex"));
static OUTPUT_FILE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.md$").expect("valid output file regex")
});

fn error_body(message: &str) -> Value {
    json!({ "message": message })
}

fn decode_path_segment(value: &str) -> Option<String> {
    urlencoding::decode(value).ok().map(|v| v.to_string())
}

fn validate_profile(value: &str) -> Result<(), &'static str> {
    if PROFILE_RE.is_match(value) {
        Ok(())
    } else {
        Err("invalid profile")
    }
}

fn validate_job_id(value: &str) -> Result<(), &'static str> {
    if JOB_ID_RE.is_match(value) {
        Ok(())
    } else {
        Err("invalid job id")
    }
}

fn validate_filename(value: &str) -> Result<(), &'static str> {
    if OUTPUT_FILE_RE.is_match(value) {
        Ok(())
    } else {
        Err("invalid run filename")
    }
}

fn parse_limit(path: &str) -> usize {
    let parsed = url::Url::parse(&format!("http://x{}", path)).ok();
    let raw = parsed
        .as_ref()
        .and_then(|url| url.query_pairs().find(|(key, _)| key == "limit"))
        .and_then(|(_, value)| value.parse::<usize>().ok())
        .unwrap_or(DEFAULT_LIMIT);
    raw.clamp(1, MAX_LIMIT)
}

fn route_path(path: &str) -> String {
    // Do not use `Url::path()` here: it normalizes dot segments, which would
    // turn `/__hermes_cron_runs/../x` into `/x` before validation.
    path.split('?').next().unwrap_or(path).to_string()
}

fn profile_home(base: &Path, profile: &str) -> PathBuf {
    if profile == "default" {
        base.to_path_buf()
    } else {
        base.join("profiles").join(profile)
    }
}

fn output_dir(base: &Path, profile: &str, job_id: &str) -> PathBuf {
    profile_home(base, profile)
        .join("cron")
        .join("output")
        .join(job_id)
}

fn canonical_starts_with(path: &Path, root: &Path) -> bool {
    match (fs::canonicalize(path), fs::canonicalize(root)) {
        (Ok(path), Ok(root)) => path.starts_with(root),
        _ => false,
    }
}

fn ensure_profile_home(base: &Path, profile: &str) -> Result<PathBuf, (u16, Value)> {
    let home = profile_home(base, profile);
    if !home.exists() || !home.is_dir() {
        return Err((404, error_body("profile not found")));
    }
    if !canonical_starts_with(&home, base) {
        return Err((403, error_body("profile is outside hermes home")));
    }
    Ok(home)
}

fn read_prefix(path: &Path, max_bytes: u64) -> std::io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut limited = file.by_ref().take(max_bytes);
    let mut bytes = Vec::new();
    limited.read_to_end(&mut bytes)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn read_detail(path: &Path) -> std::io::Result<(String, bool)> {
    let mut file = fs::File::open(path)?;
    let mut limited = file.by_ref().take(DETAIL_MAX_BYTES + 1);
    let mut bytes = Vec::new();
    limited.read_to_end(&mut bytes)?;
    let truncated = bytes.len() as u64 > DETAIL_MAX_BYTES;
    if truncated {
        bytes.truncate(DETAIL_MAX_BYTES as usize);
    }
    Ok((String::from_utf8_lossy(&bytes).into_owned(), truncated))
}

fn started_at_from_filename(filename: &str) -> String {
    // 2026-06-07_10-20-30.md -> 2026-06-07T10:20:30
    let stem = filename.strip_suffix(".md").unwrap_or(filename);
    let mut parts = stem.split('_');
    let date = parts.next().unwrap_or_default();
    let time = parts.next().unwrap_or_default().replace('-', ":");
    if date.is_empty() || time.is_empty() {
        stem.to_string()
    } else {
        format!("{}T{}", date, time)
    }
}

fn normalized_line(value: &str) -> String {
    value
        .replace('`', "")
        .replace('*', "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn truncate_chars(value: &str, max: usize) -> String {
    let mut out = String::new();
    for (idx, ch) in value.chars().enumerate() {
        if idx >= max {
            out.push('…');
            return out;
        }
        out.push(ch);
    }
    out
}

fn section_after<'a>(content: &'a str, marker: &str) -> Option<&'a str> {
    let start = content.find(marker)? + marker.len();
    let rest = &content[start..];
    if let Some(next) = rest.find("\n## ") {
        Some(&rest[..next])
    } else {
        Some(rest)
    }
}

fn first_meaningful_line(content: &str) -> Option<String> {
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty()
            || trimmed == "---"
            || trimmed == "```"
            || trimmed.starts_with("# Cron Job")
            || trimmed.starts_with("**Job ID:**")
            || trimmed.starts_with("**Run Time:**")
            || trimmed.starts_with("**Schedule:**")
            || trimmed.starts_with("## Prompt")
            || trimmed.starts_with("## Response")
            || trimmed.starts_with("## Error")
        {
            continue;
        }
        return Some(normalized_line(trimmed));
    }
    None
}

fn infer_status(content: &str) -> &'static str {
    let lower = content.to_lowercase();
    if lower.contains("**status:** blocked")
        || lower.contains("prompt-injection scanner")
        || lower.contains("blocked by injection scanner")
    {
        return "blocked";
    }
    if lower.contains("[silent]")
        || lower.contains("**status:** silent")
        || lower.contains("silent run")
        || lower.contains("wakeagent=false")
        || lower.contains("empty stdout")
    {
        return "silent";
    }
    if lower.contains("# cron job:") && lower.contains("(failed)")
        || lower.contains("\n## error")
        || lower.contains("**status:** script failed")
        || lower.contains(" script failed")
    {
        return "error";
    }
    if lower.contains("\n## response") || lower.contains("# cron job:") {
        return "success";
    }
    "unknown"
}

fn summarize_output(content: &str) -> String {
    let status = infer_status(content);
    let preferred = if matches!(status, "error" | "blocked") {
        section_after(content, "## Error").or_else(|| section_after(content, "**Scanner result:**"))
    } else {
        section_after(content, "## Response")
    };

    let candidate = preferred
        .and_then(first_meaningful_line)
        .or_else(|| first_meaningful_line(content))
        .unwrap_or_else(|| match status {
            "blocked" => "执行被安全扫描阻断".to_string(),
            "silent" => "静默执行，无需投递".to_string(),
            "error" => "执行失败".to_string(),
            "success" => "执行完成".to_string(),
            _ => "暂无摘要".to_string(),
        });

    truncate_chars(&candidate, 180)
}

fn run_json(profile: &str, job_id: &str, filename: &str, size_bytes: u64, content: &str) -> Value {
    json!({
        "job_id": job_id,
        "profile": profile,
        "filename": filename,
        "started_at": started_at_from_filename(filename),
        "status": infer_status(content),
        "summary": summarize_output(content),
        "size_bytes": size_bytes,
    })
}

fn list_runs(base: &Path, profile: &str, job_id: &str, limit: usize) -> (u16, Value) {
    if let Err(err) = validate_profile(profile).and_then(|_| validate_job_id(job_id)) {
        return (400, error_body(err));
    }
    if let Err(response) = ensure_profile_home(base, profile) {
        return response;
    }

    let dir = output_dir(base, profile, job_id);
    if !dir.exists() {
        return (
            200,
            json!({ "job_id": job_id, "profile": profile, "runs": [] }),
        );
    }
    if !dir.is_dir() || !canonical_starts_with(&dir, base) {
        return (
            403,
            error_body("cron output directory is outside hermes home"),
        );
    }

    let mut entries = match fs::read_dir(&dir) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let name = entry.file_name().to_string_lossy().to_string();
                if !OUTPUT_FILE_RE.is_match(&name) {
                    return None;
                }
                Some((name, entry.path()))
            })
            .collect::<Vec<_>>(),
        Err(_) => return (500, error_body("failed to read cron output directory")),
    };
    entries.sort_by(|a, b| b.0.cmp(&a.0));

    let runs = entries
        .into_iter()
        .take(limit)
        .filter_map(|(filename, path)| {
            if !path.is_file() || !canonical_starts_with(&path, base) {
                return None;
            }
            let metadata = fs::metadata(&path).ok()?;
            let content = read_prefix(&path, LIST_PREVIEW_BYTES).ok()?;
            Some(run_json(
                profile,
                job_id,
                &filename,
                metadata.len(),
                &content,
            ))
        })
        .collect::<Vec<_>>();

    (
        200,
        json!({ "job_id": job_id, "profile": profile, "runs": runs }),
    )
}

fn get_run_detail(base: &Path, profile: &str, job_id: &str, filename: &str) -> (u16, Value) {
    if let Err(err) = validate_profile(profile)
        .and_then(|_| validate_job_id(job_id))
        .and_then(|_| validate_filename(filename))
    {
        return (400, error_body(err));
    }
    if let Err(response) = ensure_profile_home(base, profile) {
        return response;
    }

    let file_path = output_dir(base, profile, job_id).join(filename);
    if !file_path.exists() {
        return (404, error_body("cron run not found"));
    }
    if !file_path.is_file() || !canonical_starts_with(&file_path, base) {
        return (403, error_body("cron run is outside hermes home"));
    }

    let metadata = match fs::metadata(&file_path) {
        Ok(metadata) => metadata,
        Err(_) => return (500, error_body("failed to stat cron run")),
    };
    let (content, truncated) = match read_detail(&file_path) {
        Ok(detail) => detail,
        Err(_) => return (500, error_body("failed to read cron run")),
    };

    let mut body = run_json(profile, job_id, filename, metadata.len(), &content);
    if let Value::Object(ref mut map) = body {
        map.insert("content".to_string(), json!(content));
        map.insert("truncated".to_string(), json!(truncated));
    }
    (200, body)
}

/// Handle `GET /__hermes_cron_runs/{profile}/{job_id}` and
/// `GET /__hermes_cron_runs/{profile}/{job_id}/{filename}`.
///
/// Returns `None` when the path does not belong to this local API.
pub fn handle_cron_runs_request(
    path: &str,
    method: &str,
    hermes_home_base: &str,
) -> Option<(u16, Value)> {
    let path_only = route_path(path);
    let rest = path_only.strip_prefix(ROUTE_PREFIX)?;

    if method.to_uppercase() != "GET" {
        return Some((405, error_body("method not allowed")));
    }

    let parts = rest.split('/').collect::<Vec<_>>();
    if parts.len() != 2 && parts.len() != 3 {
        return Some((404, error_body("cron run route not found")));
    }

    let profile = match decode_path_segment(parts[0]) {
        Some(value) => value,
        None => return Some((400, error_body("invalid profile"))),
    };
    let job_id = match decode_path_segment(parts[1]) {
        Some(value) => value,
        None => return Some((400, error_body("invalid job id"))),
    };

    let base = Path::new(hermes_home_base);
    if parts.len() == 2 {
        Some(list_runs(base, &profile, &job_id, parse_limit(path)))
    } else {
        let filename = match decode_path_segment(parts[2]) {
            Some(value) => value,
            None => return Some((400, error_body("invalid run filename"))),
        };
        Some(get_run_detail(base, &profile, &job_id, &filename))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use std::fs;
    use tempfile::TempDir;

    fn mkdir_profile(base: &Path, profile: &str) -> PathBuf {
        let home = profile_home(base, profile);
        fs::create_dir_all(&home).unwrap();
        home
    }

    fn write_output(base: &Path, profile: &str, job_id: &str, filename: &str, content: &str) {
        mkdir_profile(base, profile);
        let dir = output_dir(base, profile, job_id);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(filename), content).unwrap();
    }

    fn get(path: &str, base: &Path) -> (u16, Value) {
        handle_cron_runs_request(path, "GET", base.to_str().unwrap()).unwrap()
    }

    #[test]
    fn non_cron_route_returns_none() {
        let dir = TempDir::new().unwrap();
        assert!(
            handle_cron_runs_request("/api/cron/jobs", "GET", dir.path().to_str().unwrap())
                .is_none()
        );
    }

    #[test]
    fn empty_output_directory_returns_empty_runs() {
        let dir = TempDir::new().unwrap();
        mkdir_profile(dir.path(), "default");
        let (status, body) = get("/__hermes_cron_runs/default/job1", dir.path());
        assert_eq!(status, 200);
        assert_eq!(body["runs"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn list_runs_is_sorted_descending_and_limited() {
        let dir = TempDir::new().unwrap();
        write_output(
            dir.path(),
            "default",
            "job1",
            "2026-06-05_09-00-00.md",
            "# Cron Job: A\n\n## Response\n\nold",
        );
        write_output(
            dir.path(),
            "default",
            "job1",
            "2026-06-07_09-00-00.md",
            "# Cron Job: A\n\n## Response\n\nnew",
        );
        write_output(
            dir.path(),
            "default",
            "job1",
            "2026-06-06_09-00-00.md",
            "# Cron Job: A\n\n## Response\n\nmid",
        );

        let (status, body) = get("/__hermes_cron_runs/default/job1?limit=2", dir.path());
        assert_eq!(status, 200);
        let runs = body["runs"].as_array().unwrap();
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0]["filename"], "2026-06-07_09-00-00.md");
        assert_eq!(runs[1]["filename"], "2026-06-06_09-00-00.md");
    }

    #[test]
    fn rejects_invalid_profile_job_and_filename() {
        let dir = TempDir::new().unwrap();
        mkdir_profile(dir.path(), "default");

        let (status, _) = get("/__hermes_cron_runs/../job1", dir.path());
        assert_eq!(status, 400);
        let (status, _) = get("/__hermes_cron_runs/default/job%2F1", dir.path());
        assert_eq!(status, 400);
        let (status, _) = get("/__hermes_cron_runs/default/job1/../../x.md", dir.path());
        assert_eq!(status, 404);
        let (status, _) = get("/__hermes_cron_runs/default/job1/not-a-run.md", dir.path());
        assert_eq!(status, 400);
    }

    #[test]
    fn method_not_allowed_for_local_route() {
        let dir = TempDir::new().unwrap();
        let (status, body) = handle_cron_runs_request(
            "/__hermes_cron_runs/default/job1",
            "POST",
            dir.path().to_str().unwrap(),
        )
        .unwrap();
        assert_eq!(status, 405);
        assert_eq!(body["message"], "method not allowed");
    }

    #[test]
    fn infers_success_error_blocked_silent_and_unknown() {
        assert_eq!(
            infer_status("# Cron Job: A\n\n## Response\n\nok"),
            "success"
        );
        assert_eq!(
            infer_status("# Cron Job: A (FAILED)\n\n## Error\n\nboom"),
            "error"
        );
        assert_eq!(
            infer_status("**Status:** BLOCKED\nScanner result"),
            "blocked"
        );
        assert_eq!(infer_status("**Status:** silent (empty output)"), "silent");
        assert_eq!(infer_status("plain text"), "unknown");
    }

    #[test]
    fn detail_returns_content_and_truncation_flag() {
        let dir = TempDir::new().unwrap();
        write_output(
            dir.path(),
            "default",
            "job1",
            "2026-06-07_09-00-00.md",
            "# Cron Job: A\n\n## Response\n\nhello",
        );
        let (status, body) = get(
            "/__hermes_cron_runs/default/job1/2026-06-07_09-00-00.md",
            dir.path(),
        );
        assert_eq!(status, 200);
        assert_eq!(body["content"], "# Cron Job: A\n\n## Response\n\nhello");
        assert_eq!(body["truncated"], false);
        assert_eq!(body["started_at"], "2026-06-07T09:00:00");
    }

    #[test]
    fn detail_truncates_large_content() {
        let dir = TempDir::new().unwrap();
        let big = "x".repeat(DETAIL_MAX_BYTES as usize + 8);
        write_output(
            dir.path(),
            "default",
            "job1",
            "2026-06-07_09-00-00.md",
            &big,
        );
        let (status, body) = get(
            "/__hermes_cron_runs/default/job1/2026-06-07_09-00-00.md",
            dir.path(),
        );
        assert_eq!(status, 200);
        assert_eq!(body["truncated"], true);
        assert_eq!(
            body["content"].as_str().unwrap().len(),
            DETAIL_MAX_BYTES as usize
        );
    }

    #[test]
    fn named_profile_reads_only_under_profiles_directory() {
        let dir = TempDir::new().unwrap();
        write_output(
            dir.path(),
            "alpha",
            "job1",
            "2026-06-07_09-00-00.md",
            "# Cron Job: A\n\n## Response\n\nalpha",
        );
        let (status, body) = get("/__hermes_cron_runs/alpha/job1", dir.path());
        assert_eq!(status, 200);
        assert_eq!(body["runs"][0]["summary"], "alpha");
    }
}
