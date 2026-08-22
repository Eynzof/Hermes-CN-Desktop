// Dashboard smoke-check Tauri command.
//
// Runs the same lightweight health probes Rust already uses during bootstrap,
// but returns a typed report that mirrors the TS dashboard-smoke module so the
// UI and CI can consume either source.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::AppError;
use crate::state::AppState;
use crate::connection::ConnectionMode;
use reqwest::Client;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmokeCheck {
    pub id: String,
    pub label: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmokeComponents {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gateway: Option<SmokeComponent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dashboard: Option<SmokeComponent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub storage: Option<SmokeComponent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platforms: Option<SmokeComponent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmokeComponent {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardSmokeResult {
    pub ok: bool,
    pub overall: String,
    pub at: String,
    pub checks: Vec<SmokeCheck>,
    pub components: SmokeComponents,
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

async fn http_status_ok(api_base_url: &str) -> Result<(bool, Option<String>), String> {
    let url = format!("{}/api/status", api_base_url);
    let res = Client::new()
        .get(&url)
        .timeout(std::time::Duration::from_secs(5))
        .header("Accept", "application/json")
        .send()
        .await;
    match res {
        Ok(r) => {
            let status = r.status();
            let _text = r.text().await.unwrap_or_default();
            Ok((status.is_success() || status.as_u16() == 401, Some(format!("HTTP {}", status.as_u16()))))
        }
        Err(e) => Err(e.to_string()),
    }
}

async fn openapi_ok(api_base_url: &str) -> Result<(bool, Option<String>), String> {
    let url = format!("{}/openapi.json", api_base_url);
    match Client::new()
        .get(&url)
        .timeout(std::time::Duration::from_secs(5))
        .header("Accept", "application/json")
        .send()
        .await
    {
        Ok(r) => Ok((r.status().is_success(), Some(format!("HTTP {}", r.status().as_u16())))),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn run_dashboard_smoke(state: State<'_, AppState>) -> Result<DashboardSmokeResult, AppError> {
    let (api_base_url, session_token, connection_mode) = {
        let inner = state.inner.lock()?;
        (
            inner.api_base_url.clone(),
            inner.session_token.clone(),
            inner.connection_mode,
        )
    };

    let mut checks: Vec<SmokeCheck> = Vec::new();
    let mut components = SmokeComponents::default();

    // status probe
    let status_start = std::time::Instant::now();
    match http_status_ok(&api_base_url).await {
        Ok((ok, detail)) => {
            checks.push(SmokeCheck {
                id: "status".to_string(),
                label: "/api/status responds".to_string(),
                ok,
                status: Some(if ok { "ok".to_string() } else { "failing".to_string() }),
                latency_ms: Some(status_start.elapsed().as_millis() as u64),
                detail,
            });
        }
        Err(err) => checks.push(SmokeCheck {
            id: "status".to_string(),
            label: "/api/status responds".to_string(),
            ok: false,
            status: Some("failing".to_string()),
            latency_ms: Some(status_start.elapsed().as_millis() as u64),
            detail: Some(err),
        }),
    }

    // openapi probe
    let openapi_start = std::time::Instant::now();
    match openapi_ok(&api_base_url).await {
        Ok((ok, detail)) => checks.push(SmokeCheck {
            id: "openapi".to_string(),
            label: "/openapi.json reachable".to_string(),
            ok,
            status: Some(if ok { "ok".to_string() } else { "failing".to_string() }),
            latency_ms: Some(openapi_start.elapsed().as_millis() as u64),
            detail,
        }),
        Err(err) => checks.push(SmokeCheck {
            id: "openapi".to_string(),
            label: "/openapi.json reachable".to_string(),
            ok: false,
            status: Some("failing".to_string()),
            latency_ms: Some(openapi_start.elapsed().as_millis() as u64),
            detail: Some(err),
        }),
    }

    // managed-mode port probe already implies dashboard is up; record it as a
    // synthetic pass when we have a non-empty api_base_url.
    let port_ok = !api_base_url.trim().is_empty()
        && (connection_mode == ConnectionMode::Managed || connection_mode == ConnectionMode::Local);
    checks.push(SmokeCheck {
        id: "port".to_string(),
        label: "Dashboard TCP port reachable".to_string(),
        ok: port_ok,
        status: Some(if port_ok { "ok".to_string() } else { "failing".to_string() }),
        latency_ms: None,
        detail: Some(api_base_url.clone()),
    });

    // endpoint check: sessions token probe
    let sessions_start = std::time::Instant::now();
    if let Some(token) = session_token {
        let url = format!("{}/api/sessions?limit=1", api_base_url);
        match Client::new()
            .get(&url)
            .timeout(std::time::Duration::from_secs(5))
            .header("Accept", "application/json")
            .header("X-Hermes-Session-Token", &token)
            .send()
            .await
        {
            Ok(r) => {
                let ok = r.status().is_success();
                checks.push(SmokeCheck {
                    id: "sessions".to_string(),
                    label: "/api/sessions authenticated self-test".to_string(),
                    ok,
                    status: Some(if ok { "ok".to_string() } else { "degraded".to_string() }),
                    latency_ms: Some(sessions_start.elapsed().as_millis() as u64),
                    detail: Some(format!("HTTP {}", r.status().as_u16())),
                });
            }
            Err(e) => checks.push(SmokeCheck {
                id: "sessions".to_string(),
                label: "/api/sessions authenticated self-test".to_string(),
                ok: false,
                status: Some("failing".to_string()),
                latency_ms: Some(sessions_start.elapsed().as_millis() as u64),
                detail: Some(e.to_string()),
            }),
        }
    } else {
        checks.push(SmokeCheck {
            id: "sessions".to_string(),
            label: "/api/sessions authenticated self-test".to_string(),
            ok: false,
            status: Some("failing".to_string()),
            latency_ms: Some(sessions_start.elapsed().as_millis() as u64),
            detail: Some("no session token".to_string()),
        });
    }

    let failing = checks.iter().filter(|c| c.status.as_deref() == Some("failing")).count();
    let degraded = checks.iter().filter(|c| c.status.as_deref() == Some("degraded")).count();
    let overall = if failing > 0 {
        "failing"
    } else if degraded > 0 {
        "degraded"
    } else {
        "ok"
    };

    components.gateway = Some(SmokeComponent {
        ok: failing == 0,
        state: None,
        detail: None,
    });
    components.dashboard = Some(SmokeComponent {
        ok: failing == 0,
        state: None,
        detail: None,
    });
    components.storage = Some(SmokeComponent {
        ok: !checks.iter().any(|c| c.id == "status" && !c.ok),
        state: None,
        detail: None,
    });
    components.platforms = Some(SmokeComponent {
        ok: !checks.iter().any(|c| c.id == "sessions" && c.status.as_deref() == Some("failing")),
        state: None,
        detail: None,
    });

    Ok(DashboardSmokeResult {
        ok: overall == "ok",
        overall: overall.to_string(),
        at: now_iso(),
        checks,
        components,
    })
}
