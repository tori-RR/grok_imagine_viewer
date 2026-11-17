use super::{
    is_native_stage_path, is_stable_id, Asset, CaptureCompletion, CaptureFailure, Library,
    StatusCallback,
};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[cfg(windows)]
fn is_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_type().is_symlink() || metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_reparse(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn canonical_root(root: &Path) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(root).map_err(|_| "无法验证图库目录。")?;
    if !metadata.is_dir() || is_reparse(&metadata) {
        return Err("图库目录不能是符号链接或重解析点。".into());
    }
    root.canonicalize().map_err(|_| "无法验证图库目录。".into())
}

fn relative_to_root<'a>(
    root: &Path,
    canonical: &Path,
    target: &'a Path,
) -> Result<&'a Path, String> {
    target
        .strip_prefix(root)
        .or_else(|_| target.strip_prefix(canonical))
        .map_err(|_| "图库路径越出了所选目录。".to_string())
}

pub(super) fn ensure_safe_dir(root: &Path, target: &Path) -> Result<(), String> {
    let canonical = canonical_root(root)?;
    let relative = relative_to_root(root, &canonical, target)?;
    let mut current = canonical.clone();
    for component in relative.components() {
        let std::path::Component::Normal(component) = component else {
            return Err("图库目录包含无效路径。".into());
        };
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.is_dir() && !is_reparse(&metadata) => {}
            Ok(_) => return Err("图库目录包含符号链接或重解析点。".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current).map_err(|_| "无法创建图库目录。")?;
                let metadata = fs::symlink_metadata(&current).map_err(|_| "无法验证图库目录。")?;
                if !metadata.is_dir() || is_reparse(&metadata) {
                    return Err("图库目录包含符号链接或重解析点。".into());
                }
            }
            Err(_) => return Err("无法验证图库目录。".into()),
        }
        let resolved = current
            .canonicalize()
            .map_err(|_| "无法验证图库目录。".to_string())?;
        if !resolved.starts_with(&canonical) {
            return Err("图库路径越出了所选目录。".into());
        }
    }
    Ok(())
}

fn safe_existing_dir(root: &Path, target: &Path) -> bool {
    let Ok(canonical) = canonical_root(root) else {
        return false;
    };
    let Ok(relative) = relative_to_root(root, &canonical, target) else {
        return false;
    };
    let mut current = canonical.clone();
    for component in relative.components() {
        let std::path::Component::Normal(component) = component else {
            return false;
        };
        current.push(component);
        let Ok(metadata) = fs::symlink_metadata(&current) else {
            return false;
        };
        if !metadata.is_dir() || is_reparse(&metadata) {
            return false;
        }
        let Ok(resolved) = current.canonicalize() else {
            return false;
        };
        if !resolved.starts_with(&canonical) {
            return false;
        }
    }
    true
}

fn safe_existing_file_metadata(root: &Path, path: &Path) -> Option<fs::Metadata> {
    let parent = path.parent()?;
    if !safe_existing_dir(root, parent) {
        return None;
    }
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() || is_reparse(&metadata) {
        return None;
    }
    let canonical = canonical_root(root).ok()?;
    let resolved = path.canonicalize().ok()?;
    resolved.starts_with(canonical).then_some(metadata)
}
pub(super) fn safe_file_metadata(root: &Path, path: &Path) -> Result<Option<fs::Metadata>, String> {
    let parent = path
        .parent()
        .ok_or_else(|| "图库文件路径无效。".to_string())?;
    ensure_safe_dir(root, parent)?;
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !is_reparse(&metadata) => {
            let canonical = canonical_root(root)?;
            let resolved = path
                .canonicalize()
                .map_err(|_| "无法验证图库文件。".to_string())?;
            if resolved.starts_with(canonical) {
                Ok(Some(metadata))
            } else {
                Err("图库路径越出了所选目录。".into())
            }
        }
        Ok(_) => Err("图库文件不能是符号链接或重解析点。".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("无法验证图库文件。".into()),
    }
}

fn canonical_capture_path(root: &Path, path: &Path) -> Option<PathBuf> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() || is_reparse(&metadata) {
        return None;
    }
    let canonical_root = canonical_root(root).ok()?;
    let canonical_path = path.canonicalize().ok()?;
    path_is_within(&canonical_root, &canonical_path).then_some(canonical_path)
}

#[cfg(windows)]
fn normalized_windows_path(path: &Path) -> String {
    let value = path.to_string_lossy().replace('/', "\\");
    let value = if let Some(rest) = value.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{rest}")
    } else {
        value.strip_prefix("\\\\?\\").unwrap_or(&value).to_owned()
    };
    value.to_lowercase()
}

#[cfg(windows)]
fn path_is_within(root: &Path, path: &Path) -> bool {
    let root = normalized_windows_path(root);
    let path = normalized_windows_path(path);
    path == root
        || path
            .strip_prefix(&root)
            .is_some_and(|suffix| suffix.starts_with('\\'))
}

#[cfg(not(windows))]
fn path_is_within(root: &Path, path: &Path) -> bool {
    path.starts_with(root)
}

fn capture_paths_equivalent(root: &Path, expected: &Path, reported: &Path) -> bool {
    let Some(expected) = canonical_capture_path(root, expected) else {
        return false;
    };
    let Some(reported) = canonical_capture_path(root, reported) else {
        return false;
    };
    #[cfg(windows)]
    {
        normalized_windows_path(&expected) == normalized_windows_path(&reported)
    }
    #[cfg(not(windows))]
    {
        expected == reported
    }
}
pub(super) fn discard_owned_part(root: &Path, path: &Path) -> Result<(), String> {
    if safe_file_metadata(root, path)?.is_some() {
        fs::remove_file(path).map_err(|_| "无法清理下载临时文件。".to_string())?;
    }
    Ok(())
}

pub(super) struct PreparedCapture {
    part_path: PathBuf,
    final_path: PathBuf,
    expected_size: u64,
}

impl PreparedCapture {
    pub(super) fn part_path(&self) -> &Path {
        &self.part_path
    }
}

/// Copy a WebView2 local-temp write into the gallery-owned `.part`.
/// WebView2 often cannot write UNC/SMB paths (interrupt FILE_FAILED / 1).
pub(super) fn promote_native_stage(
    completion: CaptureCompletion,
) -> Result<CaptureCompletion, CaptureFailure> {
    match completion {
        CaptureCompletion::Finished {
            success: true,
            reported_path: Some(written),
            expected_size,
            part_path,
            final_path,
            forced_failure: None,
        } if written != part_path => {
            if !is_native_stage_path(&written) {
                let _ = std::fs::remove_file(&written);
                return Err(CaptureFailure::PathMismatch);
            }
            let meta = std::fs::symlink_metadata(&written).map_err(|_| CaptureFailure::Storage)?;
            if !meta.is_file() || meta.file_type().is_symlink() {
                let _ = std::fs::remove_file(&written);
                return Err(CaptureFailure::Storage);
            }
            if std::fs::copy(&written, &part_path).is_err() {
                let _ = std::fs::remove_file(&written);
                return Err(CaptureFailure::Storage);
            }
            let _ = std::fs::remove_file(&written);
            Ok(CaptureCompletion::Finished {
                success: true,
                reported_path: Some(part_path.clone()),
                expected_size,
                part_path,
                final_path,
                forced_failure: None,
            })
        }
        CaptureCompletion::Finished {
            success,
            reported_path: Some(written),
            expected_size,
            part_path,
            final_path,
            forced_failure,
        } if written != part_path => {
            if is_native_stage_path(&written) {
                let _ = std::fs::remove_file(&written);
            }
            Ok(CaptureCompletion::Finished {
                success,
                reported_path: Some(written),
                expected_size,
                part_path,
                final_path,
                forced_failure,
            })
        }
        other => Ok(other),
    }
}

pub(super) fn prepare_capture_commit(
    root: &Path,
    completion: CaptureCompletion,
) -> Result<PreparedCapture, CaptureFailure> {
    match completion {
        CaptureCompletion::Aborted { failure, part_path } => {
            let _ = discard_owned_part(root, &part_path);
            Err(failure)
        }
        CaptureCompletion::Finished {
            success,
            reported_path,
            expected_size,
            part_path,
            final_path,
            forced_failure,
        } => {
            if let Some(failure) = forced_failure {
                let _ = discard_owned_part(root, &part_path);
                return Err(failure);
            }
            if !success {
                let _ = discard_owned_part(root, &part_path);
                return Err(CaptureFailure::Failed);
            }
            let metadata = match safe_file_metadata(root, &part_path) {
                Ok(Some(metadata)) => metadata,
                missing => {
                    let _ = discard_owned_part(root, &part_path);
                    return Err(if missing.is_err() { CaptureFailure::Storage } else { CaptureFailure::MissingFile });
                }
            };
            if reported_path.as_deref().map_or(true, |reported| {
                !capture_paths_equivalent(root, &part_path, reported)
            }) {
                let _ = discard_owned_part(root, &part_path);
                return Err(CaptureFailure::PathMismatch);
            }
            if metadata.len() != expected_size {
                let _ = discard_owned_part(root, &part_path);
                return Err(CaptureFailure::SizeMismatch { expected: expected_size, received: metadata.len() });
            }
            match safe_file_metadata(root, &final_path) {
                Ok(Some(_)) => {
                    let _ = discard_owned_part(root, &part_path);
                    return Err(CaptureFailure::Conflict);
                }
                Err(_) => {
                    let _ = discard_owned_part(root, &part_path);
                    return Err(CaptureFailure::Failed);
                }
                Ok(None) => {}
            }
            if let Err(message) = sync_and_verify_file(root, &part_path, &final_path, expected_size) {
                let _ = discard_owned_part(root, &part_path);
                return Err(if message == "下载文件格式签名与扩展名不匹配。" {
                    CaptureFailure::SignatureInvalid
                } else { CaptureFailure::Storage });
            }
            Ok(PreparedCapture {
                part_path,
                final_path,
                expected_size,
            })
        }
    }
}

pub(super) fn finalize_capture(
    root: &Path,
    prepared: PreparedCapture,
) -> Result<(), CaptureFailure> {
    if safe_file_metadata(root, &prepared.final_path)
        .map_err(|_| CaptureFailure::Failed)?
        .is_some()
    {
        return Err(CaptureFailure::Conflict);
    }
    ensure_safe_dir(
        root,
        prepared.final_path.parent().ok_or(CaptureFailure::Failed)?,
    )
    .map_err(|_| CaptureFailure::Uncertain)?;
    if rename_capture_no_replace(&prepared.part_path, &prepared.final_path).is_err() {
        return reconcile_rename_outcome(root, &prepared);
    }
    verify_committed_capture(root, &prepared)
}

fn verify_committed_capture(root: &Path, prepared: &PreparedCapture) -> Result<(), CaptureFailure> {
    if sync_and_verify_file(
        root,
        &prepared.final_path,
        &prepared.final_path,
        prepared.expected_size,
    )
    .is_err()
    {
        return Err(CaptureFailure::Uncertain);
    }
    match fs::symlink_metadata(&prepared.part_path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        _ => Err(CaptureFailure::Uncertain),
    }
}

fn reconcile_rename_outcome(root: &Path, prepared: &PreparedCapture) -> Result<(), CaptureFailure> {
    let final_file =
        safe_file_metadata(root, &prepared.final_path).map_err(|_| CaptureFailure::Uncertain)?;
    let part_file =
        safe_file_metadata(root, &prepared.part_path).map_err(|_| CaptureFailure::Uncertain)?;
    match (final_file, part_file) {
        (Some(final_file), None) if final_file.len() == prepared.expected_size => {
            verify_committed_capture(root, prepared)
        }
        _ => Err(CaptureFailure::Uncertain),
    }
}

pub(super) fn recover_ready_capture(
    root: &Path,
    part_path: &Path,
    final_path: &Path,
    expected_size: u64,
) -> Result<(), String> {
    let final_file = safe_file_metadata(root, final_path)?;
    let part_file = safe_file_metadata(root, part_path)?;
    match (final_file, part_file) {
        (Some(final_file), None) => {
            if final_file.len() != expected_size {
                return Err("下载最终文件与恢复记录冲突。".into());
            }
            sync_and_verify_file(root, final_path, final_path, expected_size)
        }
        (Some(_), Some(_)) => Err("下载最终文件与临时文件同时存在；已保留现场并停止恢复。".into()),
        (None, None) => Err("已完成的下载临时文件与最终文件都不存在；已保留恢复记录。".into()),
        (None, Some(part_file)) => {
            if part_file.len() != expected_size {
                return Err("下载临时文件与恢复记录不一致。".into());
            }
            sync_and_verify_file(root, part_path, final_path, expected_size)?;
            finalize_capture(
                root,
                PreparedCapture {
                    part_path: part_path.to_path_buf(),
                    final_path: final_path.to_path_buf(),
                    expected_size,
                },
            )
            .map_err(|failure| match failure {
                CaptureFailure::Conflict => "下载最终文件与恢复记录冲突。".to_string(),
                CaptureFailure::Uncertain => {
                    "下载文件落位结果仍不确定；已保留恢复记录。".to_string()
                }
                _ => "无法恢复已完成的下载临时文件。".to_string(),
            })
        }
    }
}

fn sync_and_verify_file(
    root: &Path,
    path: &Path,
    media_path: &Path,
    expected_size: u64,
) -> Result<(), String> {
    let metadata =
        safe_file_metadata(root, path)?.ok_or_else(|| "下载文件不存在或不安全。".to_string())?;
    if metadata.len() != expected_size {
        return Err("下载文件大小不匹配。".into());
    }
    let mut file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|_| "无法打开下载文件进行持久化。".to_string())?;
    verify_media_signature(&mut file, media_path, expected_size)?;
    file.sync_all()
        .map_err(|_| "无法持久化下载文件。".to_string())?;
    let verified =
        safe_file_metadata(root, path)?.ok_or_else(|| "下载文件在持久化后不可用。".to_string())?;
    if verified.len() != expected_size {
        return Err("下载文件在持久化后大小不匹配。".into());
    }
    Ok(())
}

fn verify_media_signature(
    file: &mut fs::File,
    media_path: &Path,
    expected_size: u64,
) -> Result<(), String> {
    let extension = media_path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| "下载文件缺少受支持的扩展名。".to_string())?;
    let mut header = [0_u8; 32];
    let wanted = usize::try_from(expected_size.min(header.len() as u64))
        .map_err(|_| "下载文件大小无效。".to_string())?;
    file.read_exact(&mut header[..wanted])
        .map_err(|_| "无法读取下载文件格式签名。".to_string())?;
    let header = &header[..wanted];
    let valid = match extension.as_str() {
        "jpg" | "jpeg" => header.starts_with(&[0xff, 0xd8, 0xff]),
        "png" => header.starts_with(b"\x89PNG\r\n\x1a\n"),
        "webp" => header.len() >= 12 && &header[..4] == b"RIFF" && &header[8..12] == b"WEBP",
        "webm" => header.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]),
        "mp4" => valid_iso_bmff_first_box(header, expected_size),
        _ => false,
    };
    valid
        .then_some(())
        .ok_or_else(|| "下载文件格式签名与扩展名不匹配。".to_string())
}

fn valid_iso_bmff_first_box(header: &[u8], file_size: u64) -> bool {
    if header.len() < 8 || file_size < 8 {
        return false;
    }
    let box_type = &header[4..8];
    if !matches!(
        box_type,
        b"ftyp" | b"moov" | b"mdat" | b"free" | b"wide" | b"skip" | b"uuid" | b"styp"
    ) {
        return false;
    }
    let size32 = u32::from_be_bytes(header[..4].try_into().expect("fixed four-byte slice"));
    let (box_size, header_size) = match size32 {
        0 => (file_size, 8_u64),
        1 => {
            if header.len() < 16 {
                return false;
            }
            (
                u64::from_be_bytes(header[8..16].try_into().expect("fixed eight-byte slice")),
                16,
            )
        }
        size => (u64::from(size), 8),
    };
    let minimum = header_size + if box_type == b"uuid" { 16 } else { 0 };
    box_size >= minimum && box_size <= file_size
}

#[cfg(windows)]
fn rename_capture_no_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        core::PCWSTR,
        Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH},
    };
    let from: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    unsafe {
        MoveFileExW(
            PCWSTR(from.as_ptr()),
            PCWSTR(to.as_ptr()),
            MOVEFILE_WRITE_THROUGH,
        )
    }
    .map_err(std::io::Error::other)
}

#[cfg(not(windows))]
fn rename_capture_no_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    if destination.symlink_metadata().is_ok() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "download destination exists",
        ));
    }
    fs::rename(source, destination)
}

pub(super) fn extension(asset: &Asset) -> &'static str {
    if asset.mime == "video/webm" {
        ".webm"
    } else if asset.mime == "video/mp4" {
        ".mp4"
    } else if asset.mime == "image/png" {
        ".png"
    } else if asset.mime == "image/webp" {
        ".webp"
    } else {
        ".jpg"
    }
}

pub(super) fn matches_asset_file(path: &Path, asset: &Asset) -> bool {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let extension_matches = match asset.mime.as_str() {
        "image/jpeg" => matches!(extension.as_str(), "jpg" | "jpeg"),
        "image/png" => extension == "png",
        "image/webp" => extension == "webp",
        "video/mp4" => extension == "mp4",
        "video/webm" => extension == "webm",
        _ => false,
    };
    extension_matches
        && path.symlink_metadata().ok().is_some_and(|metadata| {
            metadata.is_file() && metadata.len() > 0
        })
        && file_has_expected_media_signature(path)
}

fn file_has_expected_media_signature(path: &Path) -> bool {
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return false,
    };
    let Ok(size) = file.metadata().map(|metadata| metadata.len()) else {
        return false;
    };
    verify_media_signature(&mut file, path, size).is_ok()
}

pub(super) fn write_state(root: &Path, library: &Library) -> Result<(), String> {
    let state = root.join("_state");
    ensure_safe_dir(root, &state).map_err(|_| "无法创建图库状态目录。")?;
    atomic_json(
        root,
        &state.join("assets.json"),
        &json!({ "assets": library.assets }),
    )?;
    atomic_json(
        root,
        &state.join("conversations.json"),
        &json!({ "conversations": library.conversations }),
    )?;
    let mut types = BTreeMap::<String, u64>::new();
    for asset in &library.assets {
        *types.entry(asset.mime.clone()).or_default() += 1;
    }
    atomic_json(
        root,
        &state.join("summary.json"),
        &json!({
            "fetchedAt": fetched_at(),
            "assets": library.assets.len(),
            "conversations": library.conversations.len(),
            "types": types
        }),
    )
}
/// How many media entries the currently published index claims. Used to refuse
/// replacing a populated index with an empty manifest.
pub(super) fn indexed_item_count(root: &Path) -> u64 {
    let Some(value) = read_json(root, &root.join("_index.json"), 32 * 1024 * 1024) else {
        return 0;
    };
    let mut total = 0_u64;
    for section in ["combos", "other"] {
        let Some(rows) = value.get(section).and_then(Value::as_array) else {
            continue;
        };
        for row in rows {
            total = total.saturating_add(row.get("count").and_then(Value::as_u64).unwrap_or(0));
        }
    }
    total
}

pub(super) fn load_trashed_ids(root: &Path) -> HashSet<String> {
    let mut ids = HashSet::new();
    let by_id = root.join(".trash").join("by-id");
    if safe_existing_dir(root, &by_id) {
        if let Ok(entries) = fs::read_dir(&by_id) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|value| value.to_str()) != Some("json")
                    || safe_existing_file_metadata(root, &path).is_none()
                {
                    continue;
                }
                if let Some(id) = path.file_stem().and_then(|value| value.to_str()) {
                    if is_stable_id(id) {
                        ids.insert(id.to_ascii_lowercase());
                    }
                }
            }
        }
    }
    for section in ["combos", "_other", "_inbox"] {
        scan_trashed_markers(root, &root.join(section), &mut ids);
    }
    ids
}

fn scan_trashed_markers(root: &Path, base: &Path, ids: &mut HashSet<String>) {
    if !safe_existing_dir(root, base) {
        return;
    }
    let Ok(folders) = fs::read_dir(base) else {
        return;
    };
    for folder in folders.flatten() {
        if !safe_existing_dir(root, &folder.path()) {
            continue;
        }
        let Ok(files) = fs::read_dir(folder.path()) else {
            continue;
        };
        for file in files.flatten() {
            if safe_existing_file_metadata(root, &file.path()).is_none() {
                continue;
            }
            let name = file.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            let Some(raw) = name.strip_suffix(".trashed") else {
                continue;
            };
            let id = Path::new(raw)
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or_default();
            if is_stable_id(id) {
                ids.insert(id.to_ascii_lowercase());
            }
        }
    }
}

pub(super) fn scan_existing(root: &Path, library: &Library) -> HashMap<String, PathBuf> {
    let assets_by_id: HashMap<String, &Asset> = library
        .assets
        .iter()
        .map(|asset| (asset.id.to_ascii_lowercase(), asset))
        .collect();
    let mut existing = HashMap::new();
    for section in ["combos", "_other", "_inbox"] {
        scan_media_folders(root, &root.join(section), &assets_by_id, &mut existing);
    }
    existing
}

fn scan_media_folders(
    root: &Path,
    base: &Path,
    assets_by_id: &HashMap<String, &Asset>,
    existing: &mut HashMap<String, PathBuf>,
) {
    if !safe_existing_dir(root, base) {
        return;
    }
    let Ok(folders) = fs::read_dir(base) else {
        return;
    };
    for folder in folders.flatten() {
        if !safe_existing_dir(root, &folder.path())
            || folder
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with('.'))
        {
            continue;
        }
        let Ok(files) = fs::read_dir(folder.path()) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            let extension = path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            if !matches!(
                extension.as_str(),
                "jpg" | "jpeg" | "png" | "webp" | "mp4" | "webm"
            ) {
                continue;
            }
            let Some(id) = path.file_stem().and_then(|value| value.to_str()) else {
                continue;
            };
            if !is_stable_id(id) {
                continue;
            }
            let lookup = id.to_ascii_lowercase();
            let Some(asset) = assets_by_id.get(&lookup) else {
                continue;
            };
            if safe_existing_file_metadata(root, &path).is_some()
                && matches_asset_file(&path, asset)
            {
                existing.entry(lookup).or_insert(path);
            }
        }
    }
}
pub(super) fn write_layout(
    root: &Path,
    library: &Library,
    existing: &HashMap<String, PathBuf>,
    trashed: &HashSet<String>,
    status: Option<&StatusCallback>,
    cancel: Option<&AtomicBool>,
) -> Result<(), String> {
    ensure_not_cancelled(cancel)?;
    write_readme(root)?;
    ensure_safe_dir(root, &root.join("combos"))?;
    ensure_safe_dir(root, &root.join("_other"))?;
    let mut folders = FolderState::load(root, cancel)?;
    ensure_not_cancelled(cancel)?;

    let conversations: HashMap<&str, _> = library
        .conversations
        .iter()
        .map(|conversation| (conversation.id.as_str(), conversation))
        .collect();
    let conversation_ids: HashSet<&str> = conversations.keys().copied().collect();
    let mut combo_ids = HashSet::<String>::new();
    for asset in &library.assets {
        if !asset.conv.is_empty() && conversation_ids.contains(asset.conv.as_str()) {
            combo_ids.insert(asset.conv.clone());
        }
        if !asset.root_conv.is_empty() && conversation_ids.contains(asset.root_conv.as_str()) {
            combo_ids.insert(asset.root_conv.clone());
        }
    }

    let mut combos = BTreeMap::<String, Vec<&Asset>>::new();
    let mut other = BTreeMap::<String, Vec<&Asset>>::new();
    for asset in &library.assets {
        let group = if !asset.conv.is_empty() && combo_ids.contains(&asset.conv) {
            asset.conv.clone()
        } else if !asset.root_conv.is_empty() && combo_ids.contains(&asset.root_conv) {
            asset.root_conv.clone()
        } else if !asset.conv.is_empty() {
            asset.conv.clone()
        } else if !asset.root_conv.is_empty() {
            asset.root_conv.clone()
        } else {
            asset.id.clone()
        };
        let natural_combo = combo_ids.contains(&group);
        if folders.prefer_combo(&group, natural_combo) {
            combos.entry(group).or_default().push(asset);
        } else {
            other.entry(group).or_default().push(asset);
        }
    }

    let mut combo_order: Vec<String> = combos.keys().cloned().collect();
    combo_order.sort_by(|left, right| {
        let left_time = conversations
            .get(left.as_str())
            .map(|value| time_key(&value.t))
            .unwrap_or((0, 0));
        let right_time = conversations
            .get(right.as_str())
            .map(|value| time_key(&value.t))
            .unwrap_or((0, 0));
        left_time.cmp(&right_time).then_with(|| left.cmp(right))
    });
    let combo_total = combo_order.len();
    if combo_total == 0 {
        emit_status(status, "index combos 0/0".into());
    }
    let mut combo_index = Vec::new();
    for (offset, id) in combo_order.iter().enumerate() {
        ensure_not_cancelled(cancel)?;
        let assignment = folders.assign(root, "combos", id)?;
        let folder = root.join("combos").join(&assignment.folder);
        let members = combos.get(id).cloned().unwrap_or_default();
        let items = build_items(root, &folder, members, existing, trashed, true, cancel)?;
        let metadata = conversations.get(id.as_str());
        let missing = missing_count(&items);
        let (images, videos) = media_counts(&items);
        atomic_json(
            root,
            &folder.join("card.json"),
            &json!({
                "n": assignment.n,
                "id": id,
                "title": metadata.map(|value| value.title.as_str()).unwrap_or_default(),
                "created": metadata.map(|value| value.t.as_str()).filter(|value| !value.is_empty()),
                "folder": assignment.folder,
                "source": "imagine_conversation",
                "count": items.len(),
                "images": images,
                "videos": videos,
                "items": items
            }),
        )?;
        combo_index.push(json!({
            "n": assignment.n,
            "id": id,
            "title": metadata.map(|value| value.title.as_str()).unwrap_or_default(),
            "folder": assignment.folder,
            "created": metadata.map(|value| value.t.as_str()).filter(|value| !value.is_empty()),
            "count": items.len(),
            "images": images,
            "videos": videos,
            "missing": missing
        }));
        emit_status(
            status,
            format!("index combos {}/{}", offset + 1, combo_total),
        );
    }

    let mut other_order: Vec<(String, Vec<&Asset>)> = other.into_iter().collect();
    other_order.sort_by(|(left_id, left), (right_id, right)| {
        earliest(left)
            .cmp(&earliest(right))
            .then_with(|| left_id.cmp(right_id))
    });
    let other_total = other_order.len();
    if other_total == 0 {
        emit_status(status, "index other 0/0".into());
    }
    let mut other_index = Vec::new();
    for (offset, (id, members)) in other_order.into_iter().enumerate() {
        ensure_not_cancelled(cancel)?;
        let assignment = folders.assign(root, "_other", &id)?;
        let folder = root.join("_other").join(&assignment.folder);
        let items = build_items(root, &folder, members, existing, trashed, false, cancel)?;
        let missing = missing_count(&items);
        let (images, videos) = media_counts(&items);
        let created = items
            .first()
            .and_then(|value| value.get("created"))
            .cloned()
            .unwrap_or(Value::Null);
        atomic_json(
            root,
            &folder.join("card.json"),
            &json!({
                "n": assignment.n,
                "id": id,
                "created": created,
                "folder": assignment.folder,
                "source": "not_in_web_combo_list",
                "count": items.len(),
                "images": images,
                "videos": videos,
                "items": items
            }),
        )?;
        other_index.push(json!({
            "n": assignment.n,
            "id": id,
            "folder": assignment.folder,
            "created": created,
            "count": items.len(),
            "images": images,
            "videos": videos,
            "missing": missing
        }));
        emit_status(
            status,
            format!("index other {}/{}", offset + 1, other_total),
        );
    }

    ensure_not_cancelled(cancel)?;
    let summary = json!({
        "fetchedAt": fetched_at(),
        "assets": library.assets.len(),
        "conversations": library.conversations.len(),
        "combos": combo_index.len(),
        "otherGroups": other_index.len(),
        "web_combos": combo_index.len(),
        "other_groups": other_index.len()
    });
    atomic_json(
        root,
        &root.join("_index.json"),
        &json!({
            "summary": summary,
            "combos": combo_index,
            "other": other_index
        }),
    )
}

fn ensure_not_cancelled(cancel: Option<&AtomicBool>) -> Result<(), String> {
    if cancel.is_some_and(|cancel| cancel.load(Ordering::Acquire)) {
        Err("下载已停止。".into())
    } else {
        Ok(())
    }
}

fn emit_status(status: Option<&StatusCallback>, message: String) {
    if let Some(status) = status {
        status(message);
    }
}

#[derive(Clone)]
struct FolderAssignment {
    n: usize,
    folder: String,
}

#[derive(Default)]
struct FolderState {
    combos: HashMap<String, FolderAssignment>,
    other: HashMap<String, FolderAssignment>,
    used_combos: HashSet<String>,
    used_other: HashSet<String>,
    next_combo: usize,
    next_other: usize,
}

impl FolderState {
    fn load(root: &Path, cancel: Option<&AtomicBool>) -> Result<Self, String> {
        let mut state = Self {
            next_combo: 1,
            next_other: 1,
            ..Self::default()
        };
        if let Some(value) = read_json(root, &root.join("_index.json"), 32 * 1024 * 1024) {
            state.load_index_rows("combos", value.get("combos"));
            state.load_index_rows("_other", value.get("other"));
        }
        state.load_cards(root, "combos", cancel)?;
        state.load_cards(root, "_other", cancel)?;
        Ok(state)
    }

    fn load_index_rows(&mut self, section: &str, rows: Option<&Value>) {
        let Some(rows) = rows.and_then(Value::as_array) else {
            return;
        };
        for row in rows {
            let id = row.get("id").and_then(Value::as_str).unwrap_or_default();
            let folder = row
                .get("folder")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let n = row
                .get("n")
                .and_then(Value::as_u64)
                .and_then(|value| usize::try_from(value).ok())
                .unwrap_or_default();
            self.remember(section, id, folder, n);
        }
    }

    fn load_cards(
        &mut self,
        root: &Path,
        section: &str,
        cancel: Option<&AtomicBool>,
    ) -> Result<(), String> {
        let base = root.join(section);
        if !safe_existing_dir(root, &base) {
            return Ok(());
        }
        let Ok(entries) = fs::read_dir(&base) else {
            return Ok(());
        };
        for entry in entries.flatten() {
            ensure_not_cancelled(cancel)?;
            let folder = entry.file_name();
            let Some(folder) = folder.to_str() else {
                continue;
            };
            if !valid_folder_name(folder) || !safe_existing_dir(root, &entry.path()) {
                continue;
            }
            let card = entry.path().join("card.json");
            let Some(value) = read_json(root, &card, 4 * 1024 * 1024) else {
                continue;
            };
            let id = value.get("id").and_then(Value::as_str).unwrap_or_default();
            let n = value
                .get("n")
                .and_then(Value::as_u64)
                .and_then(|value| usize::try_from(value).ok())
                .or_else(|| folder.split_once('_')?.0.parse().ok())
                .unwrap_or_default();
            self.remember(section, id, folder, n);
        }
        Ok(())
    }

    fn remember(&mut self, section: &str, id: &str, folder: &str, n: usize) {
        if !is_stable_id(id) || !valid_folder_name(folder) || n == 0 || n > 9_999_999 {
            return;
        }
        let (map, used, next) = if section == "combos" {
            (
                &mut self.combos,
                &mut self.used_combos,
                &mut self.next_combo,
            )
        } else {
            (&mut self.other, &mut self.used_other, &mut self.next_other)
        };
        if used.contains(folder) && map.get(id).is_none() {
            return;
        }
        used.insert(folder.to_owned());
        map.entry(id.to_owned())
            .or_insert_with(|| FolderAssignment {
                n,
                folder: folder.to_owned(),
            });
        *next = (*next).max(n.saturating_add(1));
    }

    fn prefer_combo(&self, id: &str, natural_combo: bool) -> bool {
        match (self.combos.contains_key(id), self.other.contains_key(id)) {
            (true, false) => true,
            (false, true) => false,
            _ => natural_combo,
        }
    }

    fn assign(&mut self, root: &Path, section: &str, id: &str) -> Result<FolderAssignment, String> {
        let (map, used, next) = if section == "combos" {
            (
                &mut self.combos,
                &mut self.used_combos,
                &mut self.next_combo,
            )
        } else {
            (&mut self.other, &mut self.used_other, &mut self.next_other)
        };
        if let Some(existing) = map.get(id) {
            return Ok(existing.clone());
        }
        for _ in 0..1_000_000 {
            let n = *next;
            *next = next.saturating_add(1);
            let folder = folder_name(n, id);
            if used.contains(&folder) || root.join(section).join(&folder).exists() {
                continue;
            }
            let assignment = FolderAssignment {
                n,
                folder: folder.clone(),
            };
            used.insert(folder);
            map.insert(id.to_owned(), assignment.clone());
            return Ok(assignment);
        }
        Err("无法分配安全的图库分组目录。".into())
    }
}

fn valid_folder_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && !matches!(value, "." | "..")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn read_json(root: &Path, path: &Path, max_bytes: u64) -> Option<Value> {
    let metadata = safe_existing_file_metadata(root, path)?;
    if metadata.len() == 0 || metadata.len() > max_bytes {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn build_items(
    root: &Path,
    folder: &Path,
    mut members: Vec<&Asset>,
    existing: &HashMap<String, PathBuf>,
    trashed: &HashSet<String>,
    include_conversations: bool,
    cancel: Option<&AtomicBool>,
) -> Result<Vec<Value>, String> {
    ensure_safe_dir(root, folder).map_err(|_| "无法创建图库分组目录。")?;
    members.sort_by(|left, right| {
        time_key(&left.t)
            .cmp(&time_key(&right.t))
            .then_with(|| left.id.cmp(&right.id))
    });
    let mut items = Vec::with_capacity(members.len());
    for asset in members {
        ensure_not_cancelled(cancel)?;
        let lookup = asset.id.to_ascii_lowercase();
        let destination = folder.join(format!("{}{}", asset.id, extension(asset)));
        let status = if trashed.contains(&lookup) {
            "trashed"
        } else if let Some(source) = existing.get(&lookup) {
            link_or_copy(root, source, &destination)
        } else if safe_existing_file_metadata(root, &destination)
            .is_some_and(|metadata| metadata.len() > 0)
        {
            "exists"
        } else {
            "missing"
        };
        let file = (status != "missing")
            .then(|| destination.file_name().and_then(|value| value.to_str()))
            .flatten();
        let mut item = json!({
            "id": asset.id,
            "mime": asset.mime,
            "kind": (!asset.kind.is_empty()).then_some(asset.kind.as_str()),
            "created": asset.t,
            "file": file,
            "status": status,
            "prompt": asset.prompt
        });
        if let Some(map) = item.as_object_mut() {
            if !asset.remote_url.is_empty() {
                map.insert("remoteUrl".into(), json!(asset.remote_url));
            }
            if let Some(parent) = asset.parent.as_deref().filter(|id| !id.is_empty()) {
                map.insert("parent".into(), json!(parent));
            }
            if let Some(variant) = asset.variant_of.as_deref().filter(|id| !id.is_empty()) {
                map.insert("variantOf".into(), json!(variant));
            }
            if !asset.quality.is_empty() {
                map.insert("quality".into(), json!(asset.quality));
            }
            if let Some(size) = asset.sz {
                map.insert("bytes".into(), json!(size));
            }
        }
        if include_conversations {
            if let Some(map) = item.as_object_mut() {
                map.insert(
                    "conversationId".into(),
                    json!((!asset.conv.is_empty()).then_some(asset.conv.as_str())),
                );
                map.insert(
                    "rootConversationId".into(),
                    json!((!asset.root_conv.is_empty()).then_some(asset.root_conv.as_str())),
                );
            }
        }
        items.push(item);
    }
    Ok(items)
}

fn link_or_copy(root: &Path, source: &Path, destination: &Path) -> &'static str {
    let Some(source_metadata) = safe_existing_file_metadata(root, source) else {
        return "missing";
    };
    if source_metadata.len() == 0 {
        return "missing";
    }
    if safe_existing_file_metadata(root, destination)
        .is_some_and(|metadata| metadata.len() == source_metadata.len())
    {
        return "exists";
    }
    if safe_file_metadata(root, destination).is_err() {
        return "missing";
    }
    if fs::hard_link(source, destination).is_ok() {
        return "link";
    }

    let Some(temporary) = unique_temporary(destination, "copy") else {
        return "missing";
    };
    let copied = (|| -> std::io::Result<()> {
        let mut input = fs::File::open(source)?;
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        let bytes = std::io::copy(&mut input, &mut output)?;
        output.sync_all()?;
        if bytes != source_metadata.len()
            || fs::symlink_metadata(&temporary)?.len() != source_metadata.len()
        {
            return Err(std::io::Error::other("copy length mismatch"));
        }
        fs::rename(&temporary, destination)
    })();
    if copied.is_ok() {
        "copy"
    } else {
        let _ = fs::remove_file(&temporary);
        "missing"
    }
}

fn media_counts(items: &[Value]) -> (usize, usize) {
    let videos = items
        .iter()
        .filter(|item| {
            item.get("mime")
                .and_then(Value::as_str)
                .is_some_and(|mime| mime.starts_with("video/"))
        })
        .count();
    (items.len().saturating_sub(videos), videos)
}
fn missing_count(items: &[Value]) -> usize {
    items
        .iter()
        .filter(|item| item.get("status").and_then(Value::as_str) == Some("missing"))
        .count()
}

fn folder_name(number: usize, id: &str) -> String {
    let prefix: String = id.chars().take(8).collect();
    format!("{number:04}_{prefix}")
}

fn earliest<'a>(items: &'a [&'a Asset]) -> TimeKey {
    // An empty group sorts after everything dated, matching the old "9" sentinel.
    items
        .iter()
        .map(|asset| time_key(&asset.t))
        .min()
        .unwrap_or((u8::MAX, i64::MAX))
}

/// Comparable instant plus a flag for "no usable date".
///
/// `2026-09-10T01:00:00+09:00` is earlier than `2026-09-09T23:00:00Z`, and the
/// fractional-seconds part is optional, so the raw strings cannot be compared.
/// Undated rows keep sorting first, which is where the old empty-string
/// comparison already put them, so existing folder numbering does not shift.
type TimeKey = (u8, i64);

fn time_key(value: &str) -> TimeKey {
    match timestamp_millis(value) {
        Some(millis) => (1, millis),
        None => (0, 0),
    }
}

fn timestamp_millis(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    if bytes[4] != b'-' || bytes[7] != b'-' || bytes[13] != b':' || bytes[16] != b':' {
        return None;
    }
    if !matches!(bytes[10], b'T' | b't' | b' ') {
        return None;
    }
    let field = |range: std::ops::Range<usize>| -> Option<i64> {
        let part = value.get(range)?;
        if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        part.parse::<i64>().ok()
    };
    let year = field(0..4)?;
    let month = field(5..7)?;
    let day = field(8..10)?;
    let hour = field(11..13)?;
    let minute = field(14..16)?;
    let second = field(17..19)?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    if hour > 23 || minute > 59 || second > 60 {
        return None;
    }

    let mut rest = &value[19..];
    let mut millis = 0_i64;
    if let Some(stripped) = rest.strip_prefix('.') {
        let digits = stripped
            .bytes()
            .take_while(u8::is_ascii_digit)
            .count();
        if digits == 0 {
            return None;
        }
        let mut fraction = String::from(&stripped[..digits.min(3)]);
        while fraction.len() < 3 {
            fraction.push('0');
        }
        millis = fraction.parse::<i64>().ok()?;
        rest = &stripped[digits..];
    }

    let offset_minutes = if rest.is_empty() || rest.eq_ignore_ascii_case("z") {
        0
    } else {
        let sign = match rest.as_bytes()[0] {
            b'+' => 1,
            b'-' => -1,
            _ => return None,
        };
        let body = &rest[1..];
        let (hours, minutes) = if body.len() == 5 && body.as_bytes()[2] == b':' {
            (body.get(0..2)?, body.get(3..5)?)
        } else if body.len() == 4 {
            (body.get(0..2)?, body.get(2..4)?)
        } else {
            return None;
        };
        if !hours.bytes().chain(minutes.bytes()).all(|b| b.is_ascii_digit()) {
            return None;
        }
        let hours = hours.parse::<i64>().ok()?;
        let minutes = minutes.parse::<i64>().ok()?;
        if hours > 23 || minutes > 59 {
            return None;
        }
        sign * (hours * 60 + minutes)
    };

    let days = days_from_civil(year, month, day);
    let seconds = days
        .checked_mul(86_400)?
        .checked_add(hour * 3_600 + minute * 60 + second - offset_minutes * 60)?;
    seconds.checked_mul(1_000)?.checked_add(millis)
}

/// Days since 1970-01-01 (Howard Hinnant's civil-date algorithm).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_position = (month + 9) % 12;
    let day_of_year = (153 * month_position + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn fetched_at() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or_default();
    format!("unix:{seconds}")
}

fn unique_temporary(path: &Path, label: &str) -> Option<PathBuf> {
    let parent = path.parent()?;
    let file_name = path.file_name()?.to_str()?;
    for _ in 0..32 {
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let candidate = parent.join(format!(
            ".{file_name}.giv-{}-{sequence}.{label}.tmp",
            std::process::id()
        ));
        if candidate.symlink_metadata().is_err() {
            return Some(candidate);
        }
    }
    None
}

#[cfg(windows)]
fn replace_file(temporary: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        core::PCWSTR,
        Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        },
    };
    let from: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    unsafe {
        MoveFileExW(
            PCWSTR(from.as_ptr()),
            PCWSTR(to.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    }
    .map_err(std::io::Error::other)
}

#[cfg(not(windows))]
fn replace_file(temporary: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(temporary, destination)
}

pub(super) fn atomic_json(root: &Path, path: &Path, value: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|_| "无法编码图库状态。")?;
    atomic_bytes(root, path, &bytes).map(|_| ())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReplaceReadback {
    Committed,
    DefinitelyNotCommitted,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FileReadback {
    Missing,
    Expected,
    Different,
}

fn readback_file(root: &Path, path: &Path, expected: &[u8]) -> Result<FileReadback, ()> {
    let expected_len = u64::try_from(expected.len()).map_err(|_| ())?;
    let Some(metadata) = safe_file_metadata(root, path).map_err(|_| ())? else {
        return Ok(FileReadback::Missing);
    };
    if metadata.len() != expected_len {
        return Ok(FileReadback::Different);
    }
    let mut file = fs::File::open(path).map_err(|_| ())?;
    let opened = file.metadata().map_err(|_| ())?;
    if !opened.is_file() || opened.len() != expected_len {
        return Err(());
    }
    let mut buffer = [0_u8; 8192];
    for chunk in expected.chunks(buffer.len()) {
        file.read_exact(&mut buffer[..chunk.len()])
            .map_err(|_| ())?;
        if buffer[..chunk.len()] != *chunk {
            return Ok(FileReadback::Different);
        }
    }
    if file.read(&mut buffer[..1]).map_err(|_| ())? != 0 {
        return Ok(FileReadback::Different);
    };
    let Some(after) = safe_file_metadata(root, path).map_err(|_| ())? else {
        return Err(());
    };
    if after.len() != expected_len {
        return Err(());
    }
    Ok(FileReadback::Expected)
}

fn classify_failed_replace(
    root: &Path,
    destination: &Path,
    temporary: &Path,
    expected: &[u8],
) -> ReplaceReadback {
    let destination = readback_file(root, destination, expected);
    if destination == Ok(FileReadback::Expected) {
        return ReplaceReadback::Committed;
    }
    let temporary = readback_file(root, temporary, expected);
    if matches!(
        destination,
        Ok(FileReadback::Missing | FileReadback::Different)
    ) && temporary == Ok(FileReadback::Expected)
    {
        ReplaceReadback::DefinitelyNotCommitted
    } else {
        ReplaceReadback::Unknown
    }
}

fn atomic_bytes_with_replace<F>(
    root: &Path,
    path: &Path,
    bytes: &[u8],
    replace: F,
) -> Result<bool, String>
where
    F: FnOnce(&Path, &Path) -> std::io::Result<()>,
{
    let parent = path
        .parent()
        .ok_or_else(|| "图库状态路径无效。".to_string())?;
    ensure_safe_dir(root, parent).map_err(|_| "无法创建图库状态目录。")?;
    if safe_file_metadata(root, path)?.is_some() && fs::read(path).ok().as_deref() == Some(bytes) {
        return Ok(false);
    }
    let temporary =
        unique_temporary(path, "write").ok_or_else(|| "无法创建图库临时文件。".to_string())?;
    let write_result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
        return Err("无法写入图库状态。".into());
    }
    match replace(&temporary, path) {
        Ok(()) => {
            if readback_file(root, path, bytes) == Ok(FileReadback::Expected) {
                let _ = fs::remove_file(&temporary);
                Ok(true)
            } else {
                Err(
                    "图库状态写入结果不确定；替换操作返回成功但目标内容无法确认，本次操作已停止。"
                        .into(),
                )
            }
        }
        Err(_) => match classify_failed_replace(root, path, &temporary, bytes) {
            ReplaceReadback::Committed => {
                let _ = fs::remove_file(&temporary);
                Ok(true)
            }
            ReplaceReadback::DefinitelyNotCommitted => {
                let _ = fs::remove_file(&temporary);
                Err("无法写入图库状态。".into())
            }
            ReplaceReadback::Unknown => {
                Err("图库状态写入结果不确定；为避免覆盖可能已提交的数据，本次操作已停止。".into())
            }
        },
    }
}

pub(super) fn atomic_bytes(root: &Path, path: &Path, bytes: &[u8]) -> Result<bool, String> {
    atomic_bytes_with_replace(root, path, bytes, replace_file)
}

fn write_readme(root: &Path) -> Result<(), String> {
    let path = root.join("README.md");
    if safe_file_metadata(root, &path)?.is_some() {
        return Ok(());
    }
    let text = "# Grok Imagine 导出\n\n- `combos/`：网页「查看 → 组合」\n- `_other/`：会话列表里已经没有、但文件还在的\n- 每个夹：媒体 + `card.json`\n";
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
    {
        Ok(mut file) => file
            .write_all(text.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|_| "无法写入图库说明。".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(_) => Err("无法写入图库说明。".into()),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::download::core::{Conversation, Library};

    fn fixture_root() -> PathBuf {
        std::env::temp_dir().join(format!(
            "giv-layout-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn fixture_library() -> Library {
        Library {
            assets: vec![Asset {
                id: "asset-000001".into(),
                mime: "image/jpeg".into(),
                sz: Some(5),
                t: "2026-01-01T00:00:00Z".into(),
                key: "assets/asset-000001/file.jpg".into(),
                src: String::new(),
                conv: "conversation-000001".into(),
                root_conv: String::new(),
                kind: "t2i".into(),
                prompt: "fixture".into(),
                parent: None,
                quality: String::new(),
                variant_of: None,
                remote_url: String::new(),
            }],
            conversations: vec![Conversation {
                id: "conversation-000001".into(),
                title: "Fixture".into(),
                t: "2026-01-01T00:00:00Z".into(),
            }],
        }
    }

    #[test]
    fn fixture_writes_state_card_and_index_without_real_gallery() {
        let root = fixture_root();
        let inbox = root.join("_inbox").join("0000_inbox");
        fs::create_dir_all(&inbox).unwrap();
        fs::write(inbox.join("asset-000001.jpg"), b"\xff\xd8\xff\xd9X").unwrap();
        let library = fixture_library();
        write_state(&root, &library).unwrap();
        let existing = scan_existing(&root, &library);
        write_layout(&root, &library, &existing, &HashSet::new(), None, None).unwrap();
        assert!(root.join("_state").join("assets.json").is_file());
        assert!(root.join("_index.json").is_file());
        assert!(root
            .join("combos")
            .join("0001_conversa")
            .join("card.json")
            .is_file());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn scan_existing_skips_earlier_invalid_candidates() {
        let root = fixture_root();
        let wrong_mime_dir = root.join("combos").join("0001_wrong");
        let wrong_size_dir = root.join("_other").join("0001_wrong");
        let correct_dir = root.join("_inbox").join("0000_inbox");
        fs::create_dir_all(&wrong_mime_dir).unwrap();
        fs::create_dir_all(&wrong_size_dir).unwrap();
        fs::create_dir_all(&correct_dir).unwrap();
        fs::write(wrong_mime_dir.join("asset-000001.mp4"), b"media").unwrap();
        fs::write(wrong_size_dir.join("asset-000001.jpg"), b"bad").unwrap();
        let correct = correct_dir.join("asset-000001.jpeg");
        fs::write(&correct, b"\xff\xd8\xff\xd9X").unwrap();

        let library = fixture_library();
        let existing = scan_existing(&root, &library);
        assert_eq!(existing.get("asset-000001"), Some(&correct));
        assert!(matches_asset_file(&correct, &library.assets[0]));

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn timestamps_compare_as_instants_not_as_text() {
        let east = timestamp_millis("2026-09-10T01:00:00+09:00").unwrap();
        let utc = timestamp_millis("2026-09-09T23:00:00Z").unwrap();
        assert!(east < utc, "an offset must not be ignored");
        assert!("2026-09-10T01:00:00+09:00" > "2026-09-09T23:00:00Z");

        assert_eq!(
            timestamp_millis("2026-09-09T23:00:00Z").unwrap(),
            timestamp_millis("2026-09-09T23:00:00.000Z").unwrap()
        );
        assert!(
            timestamp_millis("2026-09-09T23:00:00Z").unwrap()
                < timestamp_millis("2026-09-09T23:00:00.250Z").unwrap()
        );
        assert_eq!(
            timestamp_millis("2026-09-09T23:00:00-0130").unwrap(),
            timestamp_millis("2026-09-10T00:30:00Z").unwrap()
        );
        assert_eq!(timestamp_millis("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            timestamp_millis("2026-09-09 23:00:00"),
            timestamp_millis("2026-09-09T23:00:00")
        );

        for invalid in [
            "",
            "2026-09-09",
            "not-a-date",
            "2026-13-09T00:00:00Z",
            "2026-09-09T24:00:00Z",
            "2026-09-09T23:00:00+9",
            "2026-09-09T23:00:00.Z",
        ] {
            assert_eq!(timestamp_millis(invalid), None, "{invalid}");
        }

        // Undated rows keep the position the old empty-string comparison gave
        // them, so folder numbering does not shift for existing libraries.
        assert!(time_key("") < time_key("1970-01-01T00:00:00Z"));
        assert!(time_key("garbage") < time_key("1970-01-01T00:00:00Z"));
    }

    #[test]
    fn scan_existing_rejects_same_size_wrong_magic() {
        let root = fixture_root();
        let inbox = root.join("_inbox").join("0000_inbox");
        fs::create_dir_all(&inbox).unwrap();
        let fake = inbox.join("asset-000001.jpg");
        fs::write(&fake, b"xxxxx").unwrap();
        let library = fixture_library();
        let existing = scan_existing(&root, &library);
        assert!(!existing.contains_key("asset-000001"));
        assert!(!matches_asset_file(&fake, &library.assets[0]));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn scan_existing_keeps_usable_file_when_size_drifts() {
        let root = fixture_root();
        let inbox = root.join("_inbox").join("0000_inbox");
        fs::create_dir_all(&inbox).unwrap();
        let drifted = inbox.join("asset-000001.jpg");
        fs::write(&drifted, b"\xff\xd8\xff\xd9XXXX").unwrap();
        let library = fixture_library();
        assert_ne!(library.assets[0].sz, Some(8));
        let existing = scan_existing(&root, &library);
        assert_eq!(existing.get("asset-000001"), Some(&drifted));
        assert!(matches_asset_file(&drifted, &library.assets[0]));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn trashed_items_keep_their_deterministic_file_name() {
        let root = fixture_root();
        fs::create_dir_all(&root).unwrap();
        let library = fixture_library();
        let mut trashed = HashSet::new();
        trashed.insert("asset-000001".to_string());
        let items = build_items(
            &root,
            &root.join("_other").join("0001_fixture"),
            vec![&library.assets[0]],
            &HashMap::new(),
            &trashed,
            false,
            None,
        )
        .unwrap();
        assert_eq!(
            items[0].get("status").and_then(Value::as_str),
            Some("trashed")
        );
        assert_eq!(
            items[0].get("file").and_then(Value::as_str),
            Some("asset-000001.jpg")
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn old_combo_folder_and_number_survive_section_drift() {
        let root = fixture_root();
        fs::create_dir_all(&root).unwrap();
        let old_index = json!({
            "combos": [{
                "n": 42,
                "id": "conversation-000001",
                "folder": "0042_existing"
            }],
            "other": []
        });
        fs::write(
            root.join("_index.json"),
            serde_json::to_vec_pretty(&old_index).unwrap(),
        )
        .unwrap();
        let mut library = fixture_library();
        library.conversations.clear();
        write_layout(
            &root,
            &library,
            &HashMap::new(),
            &HashSet::new(),
            None,
            None,
        )
        .unwrap();
        let index: Value =
            serde_json::from_slice(&fs::read(root.join("_index.json")).unwrap()).unwrap();
        let row = &index["combos"][0];
        assert_eq!(row["n"].as_u64(), Some(42));
        assert_eq!(row["folder"].as_str(), Some("0042_existing"));
        assert_eq!(index["other"].as_array().map(Vec::len), Some(0));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn missing_conversation_falls_back_to_listed_root_conversation() {
        let root = fixture_root();
        fs::create_dir_all(&root).unwrap();
        let mut library = fixture_library();
        library.assets[0].conv = "conversation-missing".into();
        library.assets[0].root_conv = "conversation-000001".into();

        write_layout(
            &root,
            &library,
            &HashMap::new(),
            &HashSet::new(),
            None,
            None,
        )
        .unwrap();

        let index: Value =
            serde_json::from_slice(&fs::read(root.join("_index.json")).unwrap()).unwrap();
        assert_eq!(index["combos"].as_array().map(Vec::len), Some(1));
        assert_eq!(
            index["combos"][0]["id"].as_str(),
            Some("conversation-000001")
        );
        assert_eq!(index["other"].as_array().map(Vec::len), Some(0));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn identical_atomic_bytes_are_skipped() {
        let root = fixture_root();
        fs::create_dir_all(&root).unwrap();
        let path = root.join("state.json");
        assert!(atomic_bytes(&root, &path, b"{\"ok\":true}").unwrap());
        assert!(!atomic_bytes(&root, &path, b"{\"ok\":true}").unwrap());
        assert_eq!(fs::read(path).unwrap(), b"{\"ok\":true}");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn atomic_bytes_accepts_rename_error_when_readback_proves_commit() {
        let root = fixture_root();
        fs::create_dir_all(&root).unwrap();
        let path = root.join("state.json");
        let result = atomic_bytes_with_replace(&root, &path, b"new", |temporary, destination| {
            fs::rename(temporary, destination)?;
            Err(std::io::Error::other("simulated SMB late error"))
        });

        assert_eq!(result, Ok(true));
        assert_eq!(fs::read(&path).unwrap(), b"new");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn atomic_bytes_fails_closed_when_replace_result_cannot_be_proved() {
        let root = fixture_root();
        fs::create_dir_all(&root).unwrap();
        let path = root.join("state.json");
        fs::write(&path, b"old").unwrap();
        let error = atomic_bytes_with_replace(&root, &path, b"new", |temporary, _| {
            fs::remove_file(temporary)?;
            Err(std::io::Error::other("simulated SMB ambiguous error"))
        })
        .unwrap_err();

        assert!(error.contains("结果不确定"));
        assert_eq!(fs::read(&path).unwrap(), b"old");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn atomic_bytes_reports_definite_failure_when_owned_temp_survives() {
        let root = fixture_root();
        fs::create_dir_all(&root).unwrap();
        let path = root.join("state.json");
        fs::write(&path, b"old").unwrap();
        let error = atomic_bytes_with_replace(&root, &path, b"new", |_, _| {
            Err(std::io::Error::other("simulated pre-commit error"))
        })
        .unwrap_err();

        assert_eq!(error, "无法写入图库状态。");
        assert_eq!(fs::read(&path).unwrap(), b"old");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn atomic_bytes_does_not_trust_replace_success_without_exact_readback() {
        for previous in [None, Some(b"old".as_slice())] {
            let root = fixture_root();
            fs::create_dir_all(&root).unwrap();
            let path = root.join("state.json");
            if let Some(previous) = previous {
                fs::write(&path, previous).unwrap();
            }

            let error = atomic_bytes_with_replace(&root, &path, b"new", |_, _| Ok(()))
                .expect_err("an unverified destination must fail closed");
            assert!(error.contains("结果不确定"));
            assert_eq!(fs::read(&path).ok().as_deref(), previous);
            fs::remove_dir_all(&root).unwrap();
        }
    }

    #[test]
    fn existing_readme_is_never_overwritten() {
        let root = fixture_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("README.md"), b"user-owned").unwrap();
        write_readme(&root).unwrap();
        assert_eq!(fs::read(root.join("README.md")).unwrap(), b"user-owned");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn capture_commit_checks_reported_path_size_and_final_conflicts() {
        let root = fixture_root();
        fs::create_dir_all(&root).unwrap();
        let part = root.join("asset.jpg.giv-test.part");
        let final_path = root.join("asset.jpg");
        let jpeg = [0xff, 0xd8, 0xff, 0xd9];
        fs::write(&part, jpeg).unwrap();
        let prepared = prepare_capture_commit(
            &root,
            CaptureCompletion::Finished {
                success: true,
                reported_path: Some(part.clone()),
                expected_size: jpeg.len() as u64,
                part_path: part,
                final_path: final_path.clone(),
                forced_failure: None,
            },
        )
        .unwrap();
        finalize_capture(&root, prepared).unwrap();
        assert_eq!(fs::read(&final_path).unwrap(), jpeg);

        let bad_part = root.join("bad.jpg.giv-test.part");
        fs::write(&bad_part, b"bad").unwrap();
        assert!(matches!(
            prepare_capture_commit(
                &root,
                CaptureCompletion::Finished {
                    success: true,
                    reported_path: Some(bad_part.clone()),
                    expected_size: 5,
                    part_path: bad_part.clone(),
                    final_path: root.join("bad.jpg"),
                    forced_failure: None,
                },
            ),
            Err(CaptureFailure::SizeMismatch { expected: 5, received: 3 })
        ));
        assert!(!bad_part.exists());

        let conflict_part = root.join("conflict.jpg.giv-test.part");
        let conflict_final = root.join("conflict.jpg");
        fs::write(&conflict_part, b"new!!").unwrap();
        fs::write(&conflict_final, b"old!!").unwrap();
        assert!(matches!(
            prepare_capture_commit(
                &root,
                CaptureCompletion::Finished {
                    success: true,
                    reported_path: Some(conflict_part.clone()),
                    expected_size: 5,
                    part_path: conflict_part.clone(),
                    final_path: conflict_final.clone(),
                    forced_failure: None,
                },
            ),
            Err(CaptureFailure::Conflict)
        ));
        assert_eq!(fs::read(&conflict_final).unwrap(), b"old!!");
        assert!(!conflict_part.exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn capture_rejects_wrong_magic_even_when_size_matches() {
        let root = fixture_root();
        fs::create_dir_all(&root).unwrap();
        let part = root.join("wrong.jpg.giv-test.part");
        let final_path = root.join("wrong.jpg");
        fs::write(&part, b"nope").unwrap();

        assert!(matches!(
            prepare_capture_commit(
                &root,
                CaptureCompletion::Finished {
                    success: true,
                    reported_path: Some(part.clone()),
                    expected_size: 4,
                    part_path: part.clone(),
                    final_path,
                    forced_failure: None,
                },
            ),
            Err(CaptureFailure::SignatureInvalid)
        ));
        assert!(!part.exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn ready_recovery_rejects_wrong_magic_and_preserves_the_part() {
        let root = fixture_root();
        fs::create_dir_all(&root).unwrap();
        let part = root.join("wrong.mp4.giv-test.part");
        let final_path = root.join("wrong.mp4");
        fs::write(&part, b"not-an-mp4-box!").unwrap();

        assert!(recover_ready_capture(&root, &part, &final_path, 15).is_err());
        assert_eq!(fs::read(&part).unwrap(), b"not-an-mp4-box!");
        assert!(!final_path.exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn media_signature_accepts_supported_containers_and_reasonable_mp4_boxes() {
        let root = fixture_root();
        fs::create_dir_all(&root).unwrap();
        let fixtures: [(&str, &[u8]); 5] = [
            ("asset.jpg", &[0xff, 0xd8, 0xff, 0xd9]),
            ("asset.png", b"\x89PNG\r\n\x1a\n"),
            ("asset.webp", b"RIFF\x04\x00\x00\x00WEBP"),
            ("asset.webm", &[0x1a, 0x45, 0xdf, 0xa3]),
            ("asset.mp4", b"\x00\x00\x00\x08ftyp"),
        ];
        for (name, bytes) in fixtures {
            let path = root.join(name);
            fs::write(&path, bytes).unwrap();
            sync_and_verify_file(&root, &path, &path, bytes.len() as u64).unwrap();
        }
        for box_type in [
            b"ftyp", b"moov", b"mdat", b"free", b"wide", b"skip", b"styp",
        ] {
            let mut bytes = 8_u32.to_be_bytes().to_vec();
            bytes.extend_from_slice(box_type);
            assert!(valid_iso_bmff_first_box(&bytes, bytes.len() as u64));
        }
        let mut uuid = 24_u32.to_be_bytes().to_vec();
        uuid.extend_from_slice(b"uuid");
        uuid.extend_from_slice(&[0_u8; 16]);
        assert!(valid_iso_bmff_first_box(&uuid, uuid.len() as u64));
        assert!(!valid_iso_bmff_first_box(b"\x00\x00\x00\x08junk", 8));
        assert!(!valid_iso_bmff_first_box(b"\x00\x00\x00\x04ftyp", 8));
        let weak_jpeg = root.join("weak.jpg");
        fs::write(&weak_jpeg, [0xff, 0xd8, 0x00, 0x00]).unwrap();
        assert!(sync_and_verify_file(&root, &weak_jpeg, &weak_jpeg, 4).is_err());
        fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_extended_prefix_and_case_normalize_equally() {
        assert_eq!(
            normalized_windows_path(Path::new(r"\\?\C:\Users\Example\Asset.PART")),
            normalized_windows_path(Path::new(r"c:\users\example\asset.part"))
        );
        assert_eq!(
            normalized_windows_path(Path::new(r"\\?\UNC\Server\Share\Asset.PART")),
            normalized_windows_path(Path::new(r"\\server\share\asset.part"))
        );
    }

    #[cfg(unix)]
    #[test]
    fn managed_directory_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;
        let root = fixture_root();
        let outside = fixture_root();
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, root.join("combos")).unwrap();
        assert!(ensure_safe_dir(&root, &root.join("combos").join("0001_bad")).is_err());
        fs::remove_file(root.join("combos")).unwrap();
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
    #[test]
    fn tombstones_are_limited_to_valid_ids() {
        let root = fixture_root();
        let tombstones = root.join(".trash").join("by-id");
        fs::create_dir_all(&tombstones).unwrap();
        fs::write(tombstones.join("asset-000001.json"), b"{}").unwrap();
        fs::write(tombstones.join("..json"), b"{}").unwrap();
        let ids = load_trashed_ids(&root);
        assert!(ids.contains("asset-000001"));
        assert!(!ids.contains("."));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn promote_native_stage_copies_into_the_gallery_part() {
        let root = fixture_root();
        let inbox = root.join("_inbox").join("0000_inbox");
        fs::create_dir_all(&inbox).unwrap();
        let part = inbox.join("asset-000001.jpg.giv-0123456789abcdef0123456789abcdef.part");
        let final_path = inbox.join("asset-000001.jpg");
        let stage_dir = std::env::temp_dir().join("giv-webview2-capture");
        fs::create_dir_all(&stage_dir).unwrap();
        let stage = stage_dir.join("0123456789abcdef0123456789abcdef.part");
        fs::write(&stage, b"staged-bytes").unwrap();
        let promoted = promote_native_stage(CaptureCompletion::Finished {
            success: true,
            reported_path: Some(stage.clone()),
            expected_size: 12,
            part_path: part.clone(),
            final_path,
            forced_failure: None,
        })
        .unwrap();
        match promoted {
            CaptureCompletion::Finished {
                success: true,
                reported_path: Some(written),
                part_path,
                ..
            } => {
                assert_eq!(written, part);
                assert_eq!(part_path, part);
                assert_eq!(fs::read(&part).unwrap(), b"staged-bytes");
            }
            other => panic!("{other:?}"),
        }
        assert!(!stage.is_file());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn promote_native_stage_rejects_a_path_outside_the_stage_dir() {
        let root = fixture_root();
        fs::create_dir_all(&root).unwrap();
        let part = root.join("owned.part");
        let stranger = root.join("stranger.bin");
        fs::write(&stranger, b"nope").unwrap();
        let err = promote_native_stage(CaptureCompletion::Finished {
            success: true,
            reported_path: Some(stranger.clone()),
            expected_size: 4,
            part_path: part,
            final_path: root.join("final.bin"),
            forced_failure: None,
        });
        assert!(matches!(err, Err(CaptureFailure::PathMismatch)));
        assert!(!stranger.is_file());
        fs::remove_dir_all(&root).unwrap();
    }
}
