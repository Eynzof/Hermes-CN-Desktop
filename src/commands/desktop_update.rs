//! Desktop shell soft-update notification support.
//!
//! This deliberately only fetches the fixed public landing-site manifest. It
//! does not download installers or replace the running application; the UI uses
//! the result to guide users to the download page for manual overwrite install.

use std::collections::BTreeMap;
use std::sync::LazyLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

const DESKTOP_UPDATE_MANIFEST_URL: &str = "https://desktop.hermesagent.org.cn/latest.json";
const DESKTOP_UPDATE_TIMEOUT: Duration = Duration::from_secs(10);

/// The landing-site notification manifest URL, overridable via
/// `HERMES_DESKTOP_UPDATE_MANIFEST_URL` so self-hosters / mirror operators can
/// repoint the soft-update check without rebuilding. Empty env falls back to
/// the baked default.
fn desktop_update_manifest_url() -> String {
    std::env::var("HERMES_DESKTOP_UPDATE_MANIFEST_URL")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DESKTOP_UPDATE_MANIFEST_URL.to_string())
}

static DESKTOP_UPDATE_HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(DESKTOP_UPDATE_TIMEOUT)
        .user_agent("hermes-agent-cn-desktop-update-check")
        .build()
        .expect("valid desktop update HTTP client")
});

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdateAsset {
    pub label: Option<String>,
    pub platform: Option<String>,
    pub file_name: Option<String>,
    pub size: Option<u64>,
    pub sha256: Option<String>,
    pub url: Option<String>,
    pub versioned_url: Option<String>,
    pub source_url: Option<String>,
    pub baidu_pan_url: Option<String>,
    pub baidu_pan_code: Option<String>,
    pub quark_pan_url: Option<String>,
    pub quark_pan_code: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdateManifest {
    pub repository: Option<String>,
    pub version: Option<String>,
    pub semver: Option<String>,
    pub published_at: Option<String>,
    pub source_url: Option<String>,
    pub updated_at: Option<String>,
    pub assets: Option<BTreeMap<String, DesktopUpdateAsset>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdateManifestFetchResult {
    pub ok: bool,
    pub manifest_url: String,
    pub manifest: Option<DesktopUpdateManifest>,
    pub error: Option<String>,
    pub checked_at_ms: u64,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

async fn fetch_desktop_update_manifest_from(
    client: &reqwest::Client,
    manifest_url: &str,
) -> DesktopUpdateManifestFetchResult {
    let checked_at_ms = now_ms();
    let response = match client
        .get(manifest_url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            return DesktopUpdateManifestFetchResult {
                ok: false,
                manifest_url: manifest_url.to_string(),
                manifest: None,
                error: Some(format!("检查更新失败：{}", error)),
                checked_at_ms,
            }
        }
    };

    let status = response.status();
    if !status.is_success() {
        return DesktopUpdateManifestFetchResult {
            ok: false,
            manifest_url: manifest_url.to_string(),
            manifest: None,
            error: Some(format!("检查更新失败：服务返回异常（{}）", status.as_u16())),
            checked_at_ms,
        };
    }

    match response.json::<DesktopUpdateManifest>().await {
        Ok(manifest) => DesktopUpdateManifestFetchResult {
            ok: true,
            manifest_url: manifest_url.to_string(),
            manifest: Some(manifest),
            error: None,
            checked_at_ms,
        },
        Err(error) => DesktopUpdateManifestFetchResult {
            ok: false,
            manifest_url: manifest_url.to_string(),
            manifest: None,
            error: Some(format!("检查更新失败：更新信息格式异常（{}）", error)),
            checked_at_ms,
        },
    }
}

#[tauri::command]
pub async fn desktop_check_update() -> DesktopUpdateManifestFetchResult {
    fetch_desktop_update_manifest_from(&DESKTOP_UPDATE_HTTP_CLIENT, &desktop_update_manifest_url())
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn test_client(timeout: Duration) -> reqwest::Client {
        reqwest::Client::builder().timeout(timeout).build().unwrap()
    }

    #[test]
    #[serial_test::serial]
    fn manifest_url_env_override() {
        std::env::remove_var("HERMES_DESKTOP_UPDATE_MANIFEST_URL");
        assert_eq!(desktop_update_manifest_url(), DESKTOP_UPDATE_MANIFEST_URL);

        std::env::set_var(
            "HERMES_DESKTOP_UPDATE_MANIFEST_URL",
            "https://mirror.example.com/latest.json",
        );
        assert_eq!(
            desktop_update_manifest_url(),
            "https://mirror.example.com/latest.json"
        );

        // Blank env falls back to the baked default.
        std::env::set_var("HERMES_DESKTOP_UPDATE_MANIFEST_URL", "   ");
        assert_eq!(desktop_update_manifest_url(), DESKTOP_UPDATE_MANIFEST_URL);

        std::env::remove_var("HERMES_DESKTOP_UPDATE_MANIFEST_URL");
    }

    #[tokio::test]
    async fn fetch_manifest_successfully() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/latest.json"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "repository": "Eynzof/Hermes-CN-Desktop",
                "version": "v0.3.1",
                "semver": "0.3.1",
                "assets": {
                    "windows": {
                        "label": "Windows 安装包",
                        "fileName": "Hermes.Agent.CN.Desktop_0.3.1_x64-setup.exe",
                        "url": "https://desktop.hermesagent.org.cn/download/windows/latest.exe"
                    }
                }
            })))
            .mount(&server)
            .await;

        let result = fetch_desktop_update_manifest_from(
            &test_client(Duration::from_secs(1)),
            &format!("{}/latest.json", server.uri()),
        )
        .await;

        assert!(result.ok, "{:?}", result.error);
        let manifest = result.manifest.expect("manifest");
        assert_eq!(manifest.semver.as_deref(), Some("0.3.1"));
        assert_eq!(manifest.version.as_deref(), Some("v0.3.1"));
        assert!(manifest.assets.unwrap().contains_key("windows"));
    }

    #[tokio::test]
    async fn reports_http_error() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/latest.json"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;

        let result = fetch_desktop_update_manifest_from(
            &test_client(Duration::from_secs(1)),
            &format!("{}/latest.json", server.uri()),
        )
        .await;

        assert!(!result.ok);
        assert!(result.error.unwrap_or_default().contains("404"));
    }

    #[tokio::test]
    async fn reports_invalid_json() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/latest.json"))
            .respond_with(ResponseTemplate::new(200).set_body_string("{"))
            .mount(&server)
            .await;

        let result = fetch_desktop_update_manifest_from(
            &test_client(Duration::from_secs(1)),
            &format!("{}/latest.json", server.uri()),
        )
        .await;

        assert!(!result.ok);
        assert!(result.error.unwrap_or_default().contains("格式异常"));
    }

    #[tokio::test]
    async fn reports_timeout() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/latest.json"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_delay(Duration::from_millis(120))
                    .set_body_json(serde_json::json!({ "semver": "0.3.1" })),
            )
            .mount(&server)
            .await;

        let result = fetch_desktop_update_manifest_from(
            &test_client(Duration::from_millis(20)),
            &format!("{}/latest.json", server.uri()),
        )
        .await;

        assert!(!result.ok);
        assert!(result.error.unwrap_or_default().contains("检查更新失败"));
    }
}
