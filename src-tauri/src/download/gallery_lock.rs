use fs2::FileExt;
use serde_json::json;
use std::{
    fmt,
    fs::{File, OpenOptions},
    io::{Seek, SeekFrom, Write},
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

const LOCK_NAME: &str = ".viewer-write.lock";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum GalleryLockError {
    Busy,
    Unavailable,
}

impl fmt::Display for GalleryLockError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Busy => "图库正被另一个写入任务使用，请稍后重试。",
            Self::Unavailable => "无法取得图库写入锁，请检查目录权限和网络连接。",
        })
    }
}

pub(super) struct GalleryWriteLease {
    file: File,
}

impl GalleryWriteLease {
    pub(super) fn try_acquire(root: &Path, operation_id: &str) -> Result<Self, GalleryLockError> {
        let path = root.join(LOCK_NAME);
        let file = open_lock_file(root, &path)?;
        match FileExt::try_lock_exclusive(&file) {
            Ok(()) => {}
            Err(error) if lock_is_busy(&error) => return Err(GalleryLockError::Busy),
            Err(_) => return Err(GalleryLockError::Unavailable),
        }

        if super::layout::safe_file_metadata(root, &path)
            .map_err(|_| GalleryLockError::Unavailable)?
            .is_none()
        {
            let _ = FileExt::unlock(&file);
            return Err(GalleryLockError::Unavailable);
        }

        if write_diagnostic(&file, operation_id).is_err() {
            let _ = FileExt::unlock(&file);
            return Err(GalleryLockError::Unavailable);
        }
        Ok(Self { file })
    }
}

impl Drop for GalleryWriteLease {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

fn open_lock_file(root: &Path, path: &Path) -> Result<File, GalleryLockError> {
    match super::layout::safe_file_metadata(root, path)
        .map_err(|_| GalleryLockError::Unavailable)?
    {
        Some(_) => open_existing(path),
        None => match OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(path)
        {
            Ok(file) => Ok(file),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if super::layout::safe_file_metadata(root, path)
                    .map_err(|_| GalleryLockError::Unavailable)?
                    .is_none()
                {
                    return Err(GalleryLockError::Unavailable);
                }
                open_existing(path)
            }
            Err(_) => Err(GalleryLockError::Unavailable),
        },
    }
}

fn open_existing(path: &Path) -> Result<File, GalleryLockError> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|_| GalleryLockError::Unavailable)
}

fn write_diagnostic(mut file: &File, operation_id: &str) -> std::io::Result<()> {
    let started_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let record = json!({
        "protocol": 1,
        "owner": "tauri-download",
        "pid": std::process::id(),
        "operationId": operation_id,
        "startedAtUnix": started_at,
    });
    file.set_len(0)?;
    file.seek(SeekFrom::Start(0))?;
    serde_json::to_writer(&mut file, &record)?;
    file.write_all(b"\n")?;
    file.sync_all()
}

fn lock_is_busy(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::WouldBlock
        || matches!(
            error.raw_os_error(),
            Some(11) | Some(13) | Some(33) | Some(36)
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf};

    fn temp_root(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "giv-gallery-lock-{label}-{}-{unique}",
            std::process::id()
        ))
    }

    #[test]
    fn lease_is_exclusive_and_drop_releases_it() {
        let root = temp_root("exclusive");
        fs::create_dir_all(&root).unwrap();

        let first = GalleryWriteLease::try_acquire(&root, "first").unwrap();
        assert!(matches!(
            GalleryWriteLease::try_acquire(&root, "second"),
            Err(GalleryLockError::Busy)
        ));
        drop(first);
        assert!(GalleryWriteLease::try_acquire(&root, "third").is_ok());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn lock_file_is_permanent_and_contains_only_diagnostics() {
        let root = temp_root("diagnostic");
        fs::create_dir_all(&root).unwrap();
        {
            let _lease = GalleryWriteLease::try_acquire(&root, "unit-test").unwrap();
        }

        let path = root.join(LOCK_NAME);
        let value: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(value["protocol"], 1);
        assert_eq!(value["owner"], "tauri-download");
        assert_eq!(value["operationId"], "unit-test");
        assert!(path.is_file());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore = "manual Rust/Python OS-lock interoperability smoke"]
    fn python_process_lease_blocks_rust_writer() {
        let root = std::env::var_os("GIV_GALLERY_LOCK_TEST_ROOT")
            .map(PathBuf::from)
            .expect("set GIV_GALLERY_LOCK_TEST_ROOT to a Python-locked temp library");
        assert!(matches!(
            GalleryWriteLease::try_acquire(&root, "rust-interop-test"),
            Err(GalleryLockError::Busy)
        ));
    }
}
