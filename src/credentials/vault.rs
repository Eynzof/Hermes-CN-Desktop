//! In-memory secret vault for credentials (Phase 2 skeleton).
//!
//! Holds the secret-bearing fields (`access_token`, `refresh_token`) Rust-side
//! so secrets never need to live in the webview JS heap. The vault API exposes
//! only redacted metadata through generic listing; secrets are returned only
//! through the narrowly-scoped `get_secret`/`get_refresh_token` accessors used
//! by trusted Rust consumers.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// A stored credential secret entry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultEntry {
    pub id: String,
    pub provider: String,
    pub label: String,
    pub access_token: String,
    pub refresh_token: Option<String>,
}

/// Redacted metadata view of a vault entry; never contains secrets.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultEntryMetadata {
    pub id: String,
    pub provider: String,
    pub label: String,
}

impl From<&VaultEntry> for VaultEntryMetadata {
    fn from(entry: &VaultEntry) -> Self {
        Self {
            id: entry.id.clone(),
            provider: entry.provider.clone(),
            label: entry.label.clone(),
        }
    }
}

/// An in-memory, `Mutex`-backed credential vault.
///
/// This is the Phase 2 skeleton: no persistence, no `keyring`. It establishes
/// the security boundary (secrets stay Rust-side and are never returned by a
/// generic listing) before any consumer is wired in.
#[derive(Debug)]
pub struct CredentialVault {
    inner: Mutex<HashMap<String, VaultEntry>>,
}

impl Default for CredentialVault {
    fn default() -> Self {
        Self::new()
    }
}

impl CredentialVault {
    /// Create an empty vault.
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// Store (or overwrite) a secret-bearing entry under its id.
    pub fn put(&self, id: String, entry: VaultEntry) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.insert(id, entry);
        }
    }

    /// Retrieve the access token for a trusted Rust consumer.
    pub fn get_secret(&self, id: &str) -> Option<String> {
        self.inner
            .lock()
            .ok()
            .and_then(|inner| inner.get(id).map(|e| e.access_token.clone()))
    }

    /// Retrieve the optional refresh token for a trusted Rust consumer.
    pub fn get_refresh_token(&self, id: &str) -> Option<String> {
        self.inner
            .lock()
            .ok()
            .and_then(|inner| inner.get(id).and_then(|e| e.refresh_token.clone()))
    }

    /// Redacted metadata for a single entry (no secrets).
    pub fn metadata(&self, id: &str) -> Option<VaultEntryMetadata> {
        self.inner
            .lock()
            .ok()
            .and_then(|inner| inner.get(id).map(VaultEntryMetadata::from))
    }

    /// Redacted listing of all entries (no secrets).
    pub fn list(&self) -> Vec<VaultEntryMetadata> {
        self.inner
            .lock()
            .ok()
            .map(|inner| inner.values().map(VaultEntryMetadata::from).collect())
            .unwrap_or_default()
    }

    /// True when an entry with `id` exists.
    pub fn contains(&self, id: &str) -> bool {
        self.inner
            .lock()
            .ok()
            .map(|inner| inner.contains_key(id))
            .unwrap_or(false)
    }

    /// Number of stored entries.
    pub fn len(&self) -> usize {
        self.inner.lock().ok().map(|inner| inner.len()).unwrap_or(0)
    }

    /// Is the vault empty?
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Remove an entry, returning whether it existed.
    pub fn delete(&self, id: &str) -> bool {
        self.inner
            .lock()
            .ok()
            .map(|mut inner| inner.remove(id).is_some())
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_entry(id: &str, access_token: &str) -> VaultEntry {
        VaultEntry {
            id: id.to_string(),
            provider: "test".to_string(),
            label: id.to_string(),
            access_token: access_token.to_string(),
            refresh_token: Some(format!("refresh-{id}")),
        }
    }

    #[test]
    fn put_and_get_secret_roundtrip() {
        let vault = CredentialVault::new();
        vault.put("c1".to_string(), make_entry("c1", "tok-1"));
        assert_eq!(vault.get_secret("c1"), Some("tok-1".to_string()));
        assert_eq!(
            vault.get_refresh_token("c1"),
            Some("refresh-c1".to_string())
        );
        assert_eq!(vault.contains("c1"), true);
        assert_eq!(vault.len(), 1);
    }

    #[test]
    fn list_never_returns_secrets() {
        let vault = CredentialVault::new();
        vault.put("c1".to_string(), make_entry("c1", "tok-secret"));
        let listing = vault.list();
        assert_eq!(listing.len(), 1);
        let meta = &listing[0];
        assert_eq!(meta.id, "c1");
        assert_eq!(meta.provider, "test");
        assert_eq!(meta.label, "c1");
        // Metadata must not carry the secret-bearing fields.
        let ser = serde_json::to_value(meta).unwrap();
        assert!(ser.get("access_token").is_none());
        assert!(ser.get("refresh_token").is_none());
        assert!(ser.get("accessToken").is_none());
        assert!(ser.get("refreshToken").is_none());
    }

    #[test]
    fn metadata_omits_secrets() {
        let vault = CredentialVault::new();
        vault.put("c1".to_string(), make_entry("c1", "tok-secret"));
        let meta = vault.metadata("c1").unwrap();
        let ser = serde_json::to_value(&meta).unwrap();
        assert!(ser.get("access_token").is_none());
        assert!(ser.get("accessToken").is_none());
    }

    #[test]
    fn delete_removes_entry() {
        let vault = CredentialVault::new();
        vault.put("c1".to_string(), make_entry("c1", "tok-1"));
        assert_eq!(vault.delete("c1"), true);
        assert_eq!(vault.contains("c1"), false);
        assert_eq!(vault.len(), 0);
        assert_eq!(vault.delete("c1"), false);
    }

    #[test]
    fn is_empty_reflects_entries() {
        let vault = CredentialVault::new();
        assert_eq!(vault.is_empty(), true);
        vault.put("c1".to_string(), make_entry("c1", "tok-1"));
        assert_eq!(vault.is_empty(), false);
    }
}
