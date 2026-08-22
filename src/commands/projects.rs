//! Local Projects store (Phase B).
//!
//! This module provides the Tauri IPC surface for the desktop Projects UI.
//! Phase A continues to use the gateway JSON-RPC `projects.*` methods; these
//! commands are the in-process fallback once the managed runtime is removed.
//!
//! The schema mirrors `hermes_cli/projects_db.py`: projects, project_folders,
//! project_meta, and discovered_repos tables stored in `desktop-ui.sqlite`.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;

use crate::error::AppError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectFolder {
    pub path: String,
    pub label: Option<String>,
    pub is_primary: Option<bool>,
    pub added_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub slug: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub board_slug: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary_path: Option<String>,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archived: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folders: Option<Vec<ProjectFolder>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectsList {
    pub projects: Vec<Project>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectCreateInput {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folders: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#use: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProjectUpdateInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActiveProjectResult {
    pub active_id: Option<String>,
}

/// In-memory store used as a placeholder until the SQLite schema is wired.
struct ProjectStore {
    projects: Vec<Project>,
    active_id: Option<String>,
}

impl Default for ProjectStore {
    fn default() -> Self {
        Self {
            projects: Vec::new(),
            active_id: None,
        }
    }
}

static STORE: Mutex<ProjectStore> = Mutex::new(ProjectStore {
    projects: Vec::new(),
    active_id: None,
});

fn slugify(name: &str) -> String {
    let base: String = name
        .to_lowercase()
        .replace(|c: char| !c.is_alphanumeric() && c != '-' && c != '_', "-")
        .trim_matches('-')
        .chars()
        .take(63)
        .collect();
    let base = base.replace("--", "-");
    if base.is_empty() {
        "project".to_string()
    } else {
        base
    }
}

fn unique_slug(name: &str, existing: &[Project]) -> String {
    let base = slugify(name);
    if !existing.iter().any(|p| p.slug == base) {
        return base;
    }
    let mut suffix = 2u32;
    loop {
        let candidate = format!("{}-{}", base, suffix);
        if !existing.iter().any(|p| p.slug == candidate) {
            return candidate;
        }
        suffix += 1;
    }
}

#[tauri::command]
pub async fn projects_list() -> Result<ProjectsList, AppError> {
    let store = STORE.lock().map_err(|_| AppError::Internal("store lock".to_string()))?;
    Ok(ProjectsList {
        projects: store.projects.clone(),
        active_id: store.active_id.clone(),
    })
}

#[tauri::command]
pub async fn projects_create(input: ProjectCreateInput) -> Result<Project, AppError> {
    let mut store = STORE.lock().map_err(|_| AppError::Internal("store lock".to_string()))?;
    let id = format!("p_{:08x}", store.projects.len() + 1);
    let slug = unique_slug(&input.name, &store.projects);
    let folders: Vec<ProjectFolder> = input
        .folders
        .unwrap_or_default()
        .into_iter()
        .enumerate()
        .map(|(i, path)| ProjectFolder {
            path,
            label: None,
            is_primary: Some(i == 0),
            added_at: Some(chrono::Utc::now().to_rfc3339()),
        })
        .collect();
    let primary_path = input.primary_path.or_else(|| folders.first().map(|f| f.path.clone()));
    let project = Project {
        id: id.clone(),
        slug,
        name: input.name,
        description: None,
        icon: None,
        color: None,
        board_slug: None,
        primary_path,
        created_at: chrono::Utc::now().to_rfc3339(),
        archived: Some(false),
        folders: Some(folders),
    };
    if input.r#use.unwrap_or(true) {
        store.active_id = Some(id);
    }
    store.projects.push(project.clone());
    Ok(project)
}

#[tauri::command]
pub async fn projects_update(id: String, patch: ProjectUpdateInput) -> Result<Project, AppError> {
    let mut store = STORE.lock().map_err(|_| AppError::Internal("store lock".to_string()))?;
    let project = store
        .projects
        .iter_mut()
        .find(|p| p.id == id)
        .ok_or_else(|| AppError::Internal("project not found".to_string()))?;
    if let Some(name) = patch.name {
        project.name = name;
    }
    if let Some(description) = patch.description {
        project.description = Some(description);
    }
    if let Some(icon) = patch.icon {
        project.icon = Some(icon);
    }
    if let Some(color) = patch.color {
        project.color = Some(color);
    }
    Ok(project.clone())
}

#[tauri::command]
pub async fn projects_set_active(id: Option<String>) -> Result<ActiveProjectResult, AppError> {
    let mut store = STORE.lock().map_err(|_| AppError::Internal("store lock".to_string()))?;
    if let Some(ref project_id) = id {
        if !store.projects.iter().any(|p| &p.id == project_id) {
            return Err(AppError::Internal("project not found".to_string()));
        }
    }
    store.active_id = id.clone();
    Ok(ActiveProjectResult { active_id: id })
}

#[tauri::command]
pub async fn projects_delete(id: String) -> Result<ProjectsList, AppError> {
    let mut store = STORE.lock().map_err(|_| AppError::Internal("store lock".to_string()))?;
    store.projects.retain(|p| p.id != id);
    if store.active_id.as_deref() == Some(&id) {
        store.active_id = None;
    }
    Ok(ProjectsList {
        projects: store.projects.clone(),
        active_id: store.active_id.clone(),
    })
}

#[tauri::command]
pub async fn projects_tree() -> Result<serde_json::Value, AppError> {
    // Placeholder: returns the same list shape as the Python `projects.tree` RPC.
    let store = STORE.lock().map_err(|_| AppError::Internal("store lock".to_string()))?;
    let tree: Vec<serde_json::Value> = store
        .projects
        .iter()
        .map(|p| {
            serde_json::json!({
                "project": p,
                "repos": [],
                "no_project_sessions": [],
            })
        })
        .collect();
    Ok(serde_json::json!({ "tree": tree }))
}

#[cfg(test)]
mod tests {
    use super::*;
    static SERIAL: std::sync::LazyLock<tokio::sync::Mutex<()>> =
        std::sync::LazyLock::new(|| tokio::sync::Mutex::new(()));

    fn reset_store() {
        let mut store = STORE.lock().expect("store lock");
        *store = ProjectStore::default();
    }

    fn make_input(name: &str, folders: Vec<&str>) -> ProjectCreateInput {
        ProjectCreateInput {
            name: name.to_string(),
            folders: Some(folders.into_iter().map(String::from).collect()),
            primary_path: None,
            r#use: None,
        }
    }

    #[tokio::test]
    async fn create_project_increments_list_and_sets_active() {
        let _guard = SERIAL.lock().await;
        reset_store();

        let project = projects_create(make_input("Alpha Project", vec!["/home/alpha"])).await.unwrap();
        assert_eq!(project.name, "Alpha Project");
        assert_eq!(project.slug, "alpha-project");
        assert!(project.primary_path.as_deref().unwrap_or("").ends_with("/home/alpha"));

        let list = projects_list().await.unwrap();
        assert_eq!(list.projects.len(), 1);
        assert_eq!(list.active_id, Some(project.id));
    }

    #[tokio::test]
    async fn slug_collision_appends_counter() {
        let _guard = SERIAL.lock().await;
        reset_store();

        let first = projects_create(make_input("My Project", vec!["/a"])).await.unwrap();
        let second = projects_create(make_input("My Project", vec!["/b"])).await.unwrap();
        assert_eq!(first.slug, "my-project");
        assert_eq!(second.slug, "my-project-2");
    }

    #[tokio::test]
    async fn update_project_mutates_fields() {
        let _guard = SERIAL.lock().await;
        reset_store();

        let project = projects_create(make_input("Old", vec!["/x"])).await.unwrap();
        let updated = projects_update(
            project.id.clone(),
            ProjectUpdateInput {
                name: Some("New".to_string()),
                description: Some("desc".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(updated.name, "New");
        assert_eq!(updated.description.as_deref(), Some("desc"));
    }

    #[tokio::test]
    async fn set_active_refuses_unknown_project() {
        let _guard = SERIAL.lock().await;
        reset_store();

        let err = projects_set_active(Some("missing".to_string())).await.unwrap_err();
        assert!(matches!(err, AppError::Internal(_)));
    }

    #[tokio::test]
    async fn delete_project_removes_and_clears_active() {
        let _guard = SERIAL.lock().await;
        reset_store();

        let p1 = projects_create(make_input("One", vec!["/one"])).await.unwrap();
        assert_eq!(projects_list().await.unwrap().active_id, Some(p1.id.clone()));
        let list = projects_delete(p1.id).await.unwrap();
        assert_eq!(list.projects.len(), 0);
        assert!(list.active_id.is_none());
    }

    #[tokio::test]
    async fn tree_returns_project_nodes() {
        let _guard = SERIAL.lock().await;
        reset_store();

        let project = projects_create(make_input("Tree", vec!["/tree"])).await.unwrap();
        let tree = projects_tree().await.unwrap();
        let nodes = tree.get("tree").and_then(|v| v.as_array()).expect("tree array");
        assert_eq!(nodes.len(), 1);
        let slug = nodes[0]
            .get("project")
            .and_then(|p| p.get("slug"))
            .and_then(|s| s.as_str());
        assert_eq!(slug, Some(project.slug.as_str()));
    }
}
