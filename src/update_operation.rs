//! One update transaction across the public and advanced updater entrypoints.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::LazyLock;

static BUSY: AtomicBool = AtomicBool::new(false);
static CANCELLED: AtomicBool = AtomicBool::new(false);
static CANCEL: LazyLock<tokio::sync::Notify> = LazyLock::new(tokio::sync::Notify::new);

pub struct UpdateOperation;

impl UpdateOperation {
    pub fn begin() -> Result<Self, String> {
        BUSY.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| "已有更新操作正在进行，请稍候".to_string())?;
        CANCELLED.store(false, Ordering::SeqCst);
        Ok(Self)
    }
}

impl Drop for UpdateOperation {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::SeqCst);
    }
}

pub fn busy() -> bool {
    BUSY.load(Ordering::SeqCst)
}

pub fn cancel() {
    CANCELLED.store(true, Ordering::SeqCst);
    // One downloader owns the operation. A stored permit closes the race
    // between checking CANCELLED and first polling the notification future.
    CANCEL.notify_one();
}

pub async fn cancelled() {
    loop {
        let notified = CANCEL.notified();
        if CANCELLED.load(Ordering::SeqCst) {
            return;
        }
        notified.await;
    }
}

/// Reports bytes actually received; an absent Content-Length stays indeterminate.
pub async fn response_bytes(mut response: reqwest::Response) -> Result<Vec<u8>, String> {
    let total = response.content_length();
    let mut bytes = Vec::new();
    let mut reported = std::time::Instant::now();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        bytes.extend_from_slice(&chunk);
        if reported.elapsed() >= std::time::Duration::from_millis(150) {
            crate::commands::software_update::download_progress(bytes.len() as u64, total);
            reported = std::time::Instant::now();
        }
    }
    crate::commands::software_update::download_progress(bytes.len() as u64, total);
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn competing_operations_are_rejected_and_drop_releases_guard() {
        let operation = UpdateOperation::begin().unwrap();
        assert!(UpdateOperation::begin().is_err());
        drop(operation);
        assert!(UpdateOperation::begin().is_ok());
    }
}
