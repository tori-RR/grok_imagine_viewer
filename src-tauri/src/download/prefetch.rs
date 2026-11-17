//! One bounded page-side prefetch overlaps network preparation with the current
//! file's native capture/commit. Journal and download capture remain serial.
use super::{windows_runtime, NavigationGuard, Runtime, Webview};
use std::{sync::{atomic::{AtomicBool, Ordering}, Arc}, thread::{self, JoinHandle}};

pub(super) const PREFETCH_BYTES: u64 = 32 * 1024 * 1024;

pub(super) fn allowed(current_bytes: u64, next_declared: Option<u64>) -> bool {
    (1..=PREFETCH_BYTES).contains(&current_bytes)
        && next_declared.is_some_and(|size| (1..=PREFETCH_BYTES).contains(&size))
}

pub(super) struct Prefetch<R: Runtime> {
    id: String,
    webview: Webview<R>,
    navigation: NavigationGuard,
    cancel: Arc<AtomicBool>,
    worker: Option<JoinHandle<Result<windows_runtime::PreparedBlob, windows_runtime::PageFailure>>>,
}

impl<R: Runtime> Prefetch<R> {
    pub(super) fn start(webview: Webview<R>, navigation: NavigationGuard, id: &str, key: &str, mime: &str) -> Option<Self> {
        let cancel = Arc::new(AtomicBool::new(false));
        let child_cancel = Arc::clone(&cancel);
        let child_webview = webview.clone(); let child_navigation = navigation.clone();
        let key = key.to_owned(); let mime = mime.to_owned();
        let worker = thread::Builder::new().name("giv-prefetch".into()).spawn(move || {
            windows_runtime::prepare_asset_limited(&child_webview, &key, &mime, &child_cancel, &child_navigation, PREFETCH_BYTES, false)
        }).ok()?;
        Some(Self { id: id.into(), webview, navigation, cancel, worker: Some(worker) })
    }

    pub(super) fn take(mut self, id: &str, run_cancel: &AtomicBool) -> Option<Result<windows_runtime::PreparedBlob, windows_runtime::PageFailure>> {
        if self.id != id { return None; }
        let worker = self.worker.take()?;
        while !worker.is_finished() {
            if run_cancel.load(Ordering::Acquire) { self.cancel.store(true, Ordering::Release); }
            thread::sleep(std::time::Duration::from_millis(25));
        }
        worker.join().ok()
    }
}

impl<R: Runtime> Drop for Prefetch<R> {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            if let Ok(Ok(blob)) = worker.join() {
                windows_runtime::revoke_blob(&self.webview, &blob, &self.cancel, &self.navigation);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_two_small_known_files_may_overlap() {
        assert!(allowed(PREFETCH_BYTES, Some(PREFETCH_BYTES)));
        assert!(!allowed(PREFETCH_BYTES+1, Some(1)));
        assert!(!allowed(1, Some(PREFETCH_BYTES+1)));
        assert!(!allowed(1,None)); assert!(!allowed(1,Some(0)));
    }
}
