use super::{is_stable_id, layout, Library, MAX_MEDIA_BYTES};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
};

const JOURNAL_NAME: &str = ".giv-download-journal-v1.json";
const SNAPSHOT_NAME: &str = ".giv-download-manifest-v2.json";
const JOURNAL_VERSION: u8 = 2;
const LEGACY_JOURNAL_VERSION: u8 = 1;
const SNAPSHOT_VERSION: u8 = 1;
const JOURNAL_V1_MAX_MEDIA_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_JOURNAL_BYTES: u64 = 64 * 1024;
const MAX_MANIFEST_SNAPSHOT_BYTES: u64 = 32 * 1024 * 1024;
const INVALID_JOURNAL: &str = "下载恢复记录无效；为避免误删文件，本次下载已停止。";
const INVALID_SNAPSHOT: &str = "下载清单快照无效；为避免发布错误图库，本次下载已停止。";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct JournalRecord {
    version: u8,
    run_token: String,
    phase: JournalPhase,
    #[serde(skip_serializing_if = "Option::is_none")]
    active: Option<ActiveMedia>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    manifest_sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct ManifestSnapshot {
    version: u8,
    run_token: String,
    library: Library,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum JournalPhase {
    Media,
    Publishing,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct ActiveMedia {
    asset_id: String,
    extension: String,
    part_token: String,
    expected_size: u64,
    state: ActiveState,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum ActiveState {
    Armed,
    Ready,
}

pub(super) struct DownloadJournal {
    root: PathBuf,
    record: JournalRecord,
}

#[derive(Debug, Clone)]
pub(super) enum RecoveryState {
    Ready,
    Publishing(Library),
}

impl ActiveMedia {
    fn validate(&self) -> Result<(), String> {
        if !is_stable_id(&self.asset_id)
            || !matches!(
                self.extension.as_str(),
                ".jpg" | ".png" | ".webp" | ".mp4" | ".webm"
            )
            || !valid_token(&self.part_token)
            || !(1..=JOURNAL_V1_MAX_MEDIA_BYTES).contains(&self.expected_size)
        {
            return Err(INVALID_JOURNAL.into());
        }
        Ok(())
    }

    fn paths(&self, root: &Path) -> Result<(PathBuf, PathBuf), String> {
        self.validate()?;
        let final_path = root
            .join("_inbox")
            .join("0000_inbox")
            .join(format!("{}{}", self.asset_id, self.extension));
        let mut part = OsString::from(final_path.as_os_str());
        part.push(format!(".giv-{}.part", self.part_token));
        Ok((PathBuf::from(part), final_path))
    }
}

impl JournalRecord {
    fn validate(&self) -> Result<(), String> {
        if !matches!(self.version, LEGACY_JOURNAL_VERSION | JOURNAL_VERSION)
            || !valid_token(&self.run_token)
            || (self.phase == JournalPhase::Publishing && self.active.is_some())
        {
            return Err(INVALID_JOURNAL.into());
        }
        match self.version {
            LEGACY_JOURNAL_VERSION if self.manifest_sha256.is_none() => {}
            JOURNAL_VERSION if self.manifest_sha256.as_deref().is_some_and(valid_sha256) => {}
            _ => return Err(INVALID_JOURNAL.into()),
        }
        if let Some(active) = &self.active {
            active.validate()?;
        }
        Ok(())
    }
}

impl DownloadJournal {
    pub(super) fn recover(root: &Path) -> Result<RecoveryState, String> {
        let Some(mut record) = read_record(root)? else {
            return Ok(RecoveryState::Ready);
        };
        record.validate()?;
        let snapshot = if record.version == JOURNAL_VERSION {
            Some(read_manifest_snapshot(root, &record)?)
        } else {
            None
        };
        if let Some(active) = record.active.clone() {
            let (part_path, final_path) = active.paths(root)?;
            match active.state {
                ActiveState::Armed => layout::discard_owned_part(root, &part_path)?,
                ActiveState::Ready => layout::recover_ready_capture(
                    root,
                    &part_path,
                    &final_path,
                    active.expected_size,
                )?,
            }
            record.active = None;
            persist_record(root, &record)?;
        }
        Ok(match record.phase {
            JournalPhase::Media => RecoveryState::Ready,
            JournalPhase::Publishing => RecoveryState::Publishing(snapshot.ok_or_else(|| {
                "旧版下载发布记录没有受控清单快照；为避免发布错误图库，本次下载已停止。".to_string()
            })?),
        })
    }

    pub(super) fn begin(root: &Path, library: &Library) -> Result<Self, String> {
        if let Some(record) = read_record(root)? {
            if record.active.is_some() || record.phase == JournalPhase::Publishing {
                return Err("上一次下载恢复记录尚未处理。".into());
            }
            remove_record(root)?;
        }
        remove_snapshot(root)?;
        let run_token = random_token()?;
        let snapshot = ManifestSnapshot {
            version: SNAPSHOT_VERSION,
            run_token: run_token.clone(),
            library: library.clone(),
        };
        let snapshot_bytes = encode_snapshot(&snapshot)?;
        let manifest_sha256 = sha256_hex(&snapshot_bytes);
        layout::atomic_bytes(root, &snapshot_path(root), &snapshot_bytes)?;
        let record = JournalRecord {
            version: JOURNAL_VERSION,
            run_token,
            phase: JournalPhase::Media,
            active: None,
            manifest_sha256: Some(manifest_sha256),
        };
        persist_record(root, &record)?;
        Ok(Self {
            root: root.to_path_buf(),
            record,
        })
    }

    pub(super) fn arm(
        &mut self,
        asset_id: &str,
        extension: &str,
        part_token: &str,
        expected_size: u64,
    ) -> Result<(), String> {
        if self.record.phase != JournalPhase::Media || self.record.active.is_some() {
            return Err("下载恢复记录状态冲突。".into());
        }
        if !(1..=MAX_MEDIA_BYTES).contains(&expected_size) {
            return Err("媒体大小超过当前下载准入上限。".into());
        }
        let active = ActiveMedia {
            asset_id: asset_id.to_owned(),
            extension: extension.to_owned(),
            part_token: part_token.to_owned(),
            expected_size,
            state: ActiveState::Armed,
        };
        active.validate()?;
        self.record.active = Some(active);
        if let Err(error) = persist_record(&self.root, &self.record) {
            self.record.active = None;
            return Err(error);
        }
        Ok(())
    }

    pub(super) fn mark_ready(&mut self) -> Result<(), String> {
        let Some(active) = self.record.active.as_mut() else {
            return Err("下载恢复记录没有活动媒体。".into());
        };
        if active.state != ActiveState::Armed {
            return Err("下载恢复记录状态冲突。".into());
        }
        active.state = ActiveState::Ready;
        if let Err(error) = persist_record(&self.root, &self.record) {
            if let Some(active) = self.record.active.as_mut() {
                active.state = ActiveState::Armed;
            }
            return Err(error);
        }
        Ok(())
    }

    pub(super) fn abort_active(&mut self) -> Result<(), String> {
        let Some(active) = self.record.active.clone() else {
            return Ok(());
        };
        if active.state != ActiveState::Armed {
            return Err("已持久化的下载临时文件必须由恢复流程处理。".into());
        }
        let (part_path, _) = active.paths(&self.root)?;
        layout::discard_owned_part(&self.root, &part_path)?;
        self.clear_active()
    }

    pub(super) fn clear_active(&mut self) -> Result<(), String> {
        let previous = self.record.active.take();
        if let Err(error) = persist_record(&self.root, &self.record) {
            self.record.active = previous;
            return Err(error);
        }
        Ok(())
    }

    pub(super) fn mark_publishing(&mut self) -> Result<Library, String> {
        if self.record.active.is_some() || self.record.phase != JournalPhase::Media {
            return Err("下载恢复记录状态冲突。".into());
        }
        let library = read_manifest_snapshot(&self.root, &self.record)?;
        self.record.phase = JournalPhase::Publishing;
        if let Err(error) = persist_record(&self.root, &self.record) {
            self.record.phase = JournalPhase::Media;
            return Err(error);
        }
        Ok(library)
    }

    pub(super) fn finish(self) -> Result<(), String> {
        if self.record.active.is_some() || self.record.phase != JournalPhase::Publishing {
            return Err("下载恢复记录尚未完成。".into());
        }
        remove_record(&self.root)?;
        remove_snapshot(&self.root)
    }

    pub(super) fn finish_recovered_publish(root: &Path) -> Result<(), String> {
        let record = read_record(root)?.ok_or_else(|| "上一次下载发布记录不存在。".to_string())?;
        if record.active.is_some() || record.phase != JournalPhase::Publishing {
            return Err("上一次下载发布记录状态冲突。".into());
        }
        read_manifest_snapshot(root, &record)?;
        remove_record(root)?;
        remove_snapshot(root)
    }
}

fn journal_path(root: &Path) -> PathBuf {
    root.join("_state").join(JOURNAL_NAME)
}

fn snapshot_path(root: &Path) -> PathBuf {
    root.join("_state").join(SNAPSHOT_NAME)
}

fn read_record(root: &Path) -> Result<Option<JournalRecord>, String> {
    let path = journal_path(root);
    let Some(metadata) = layout::safe_file_metadata(root, &path)? else {
        return Ok(None);
    };
    if metadata.len() == 0 || metadata.len() > MAX_JOURNAL_BYTES {
        return Err(INVALID_JOURNAL.into());
    }
    let bytes = fs::read(&path).map_err(|_| INVALID_JOURNAL.to_string())?;
    let record: JournalRecord =
        serde_json::from_slice(&bytes).map_err(|_| INVALID_JOURNAL.to_string())?;
    record.validate()?;
    Ok(Some(record))
}

fn persist_record(root: &Path, record: &JournalRecord) -> Result<(), String> {
    record.validate()?;
    let value = serde_json::to_value(record).map_err(|_| "无法编码下载恢复记录。".to_string())?;
    layout::atomic_json(root, &journal_path(root), &value)
}

fn encode_snapshot(snapshot: &ManifestSnapshot) -> Result<Vec<u8>, String> {
    let bytes = serde_json::to_vec(snapshot).map_err(|_| "无法编码下载清单快照。".to_string())?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_MANIFEST_SNAPSHOT_BYTES {
        return Err("下载清单快照超过安全上限。".into());
    }
    Ok(bytes)
}

fn read_manifest_snapshot(root: &Path, record: &JournalRecord) -> Result<Library, String> {
    if record.version != JOURNAL_VERSION {
        return Err(INVALID_SNAPSHOT.into());
    }
    let expected_digest = record
        .manifest_sha256
        .as_deref()
        .filter(|digest| valid_sha256(digest))
        .ok_or_else(|| INVALID_SNAPSHOT.to_string())?;
    let path = snapshot_path(root);
    let metadata =
        layout::safe_file_metadata(root, &path)?.ok_or_else(|| INVALID_SNAPSHOT.to_string())?;
    if metadata.len() == 0 || metadata.len() > MAX_MANIFEST_SNAPSHOT_BYTES {
        return Err(INVALID_SNAPSHOT.into());
    }
    let bytes = fs::read(&path).map_err(|_| INVALID_SNAPSHOT.to_string())?;
    if bytes.len() as u64 != metadata.len() || sha256_hex(&bytes) != expected_digest {
        return Err(INVALID_SNAPSHOT.into());
    }
    let snapshot: ManifestSnapshot =
        serde_json::from_slice(&bytes).map_err(|_| INVALID_SNAPSHOT.to_string())?;
    if snapshot.version != SNAPSHOT_VERSION || snapshot.run_token != record.run_token {
        return Err(INVALID_SNAPSHOT.into());
    }
    let library = snapshot
        .library
        .validate()
        .map_err(|_| INVALID_SNAPSHOT.to_string())?;
    let canonical = encode_snapshot(&ManifestSnapshot {
        version: snapshot.version,
        run_token: snapshot.run_token,
        library: library.clone(),
    })?;
    if canonical != bytes {
        return Err(INVALID_SNAPSHOT.into());
    }
    Ok(library)
}

fn remove_record(root: &Path) -> Result<(), String> {
    remove_controlled_file(root, &journal_path(root), "下载恢复记录", |path| {
        fs::remove_file(path)
    })
}

fn remove_snapshot(root: &Path) -> Result<(), String> {
    remove_controlled_file(root, &snapshot_path(root), "下载清单快照", |path| {
        fs::remove_file(path)
    })
}

fn remove_controlled_file<F>(root: &Path, path: &Path, label: &str, remove: F) -> Result<(), String>
where
    F: FnOnce(&Path) -> std::io::Result<()>,
{
    if layout::safe_file_metadata(root, path)?.is_none() {
        return Ok(());
    }
    match remove(path) {
        Ok(()) => match layout::safe_file_metadata(root, path) {
            Ok(None) => Ok(()),
            Ok(Some(_)) => Err(format!("无法清理{label}。")),
            Err(_) => Err(format!(
                "{label}清理结果不确定；为避免破坏恢复事务，本次操作已停止。"
            )),
        },
        Err(_) => match layout::safe_file_metadata(root, path) {
            Ok(None) => Ok(()),
            Ok(Some(_)) => Err(format!("无法清理{label}。")),
            Err(_) => Err(format!(
                "{label}清理结果不确定；为避免破坏恢复事务，本次操作已停止。"
            )),
        },
    }
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| "无法生成下载恢复记录编号。".to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn valid_token(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::download::core::{Asset, Conversation};
    use serde_json::Value;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn root(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "giv-journal-{label}-{}-{unique}",
            std::process::id()
        ))
    }

    fn prepare_root(label: &str) -> PathBuf {
        let root = root(label);
        fs::create_dir_all(root.join("_inbox").join("0000_inbox")).unwrap();
        root
    }

    fn library(label: &str) -> Library {
        Library {
            assets: vec![Asset {
                id: format!("asset-{label}"),
                mime: "image/jpeg".into(),
                sz: Some(5),
                t: "2026-01-01T00:00:00Z".into(),
                key: format!("assets/asset-{label}/file.jpg"),
                src: String::new(),
                conv: format!("conversation-{label}"),
                root_conv: String::new(),
                kind: "t2i".into(),
                prompt: format!("prompt-{label}"),
                parent: None,
                quality: String::new(),
                variant_of: None,
                remote_url: String::new(),
            }],
            conversations: vec![Conversation {
                id: format!("conversation-{label}"),
                title: format!("Conversation {label}"),
                t: "2026-01-01T00:00:00Z".into(),
            }],
        }
    }

    #[test]
    fn invalid_journal_fails_closed_and_never_deletes_parts() {
        let root = prepare_root("invalid");
        fs::create_dir_all(root.join("_state")).unwrap();
        let part = root
            .join("_inbox")
            .join("0000_inbox")
            .join("asset01.jpg.giv-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.part");
        fs::write(&part, b"owned-by-unknown-run").unwrap();
        fs::write(journal_path(&root), b"{not-json").unwrap();

        assert!(DownloadJournal::recover(&root).is_err());
        assert!(part.is_file());
        assert!(journal_path(&root).is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn armed_recovery_removes_only_the_exact_recorded_part() {
        let root = prepare_root("armed");
        let token = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let unrelated = root
            .join("_inbox")
            .join("0000_inbox")
            .join("asset01.jpg.giv-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.part");
        let exact = root
            .join("_inbox")
            .join("0000_inbox")
            .join(format!("asset01.jpg.giv-{token}.part"));
        let fixture = library("armed");
        let mut journal = DownloadJournal::begin(&root, &fixture).unwrap();
        journal.arm("asset01", ".jpg", token, 5).unwrap();
        fs::write(&exact, b"short").unwrap();
        fs::write(&unrelated, b"leave").unwrap();
        drop(journal);

        assert!(matches!(
            DownloadJournal::recover(&root).unwrap(),
            RecoveryState::Ready
        ));
        assert!(!exact.exists());
        assert_eq!(fs::read(&unrelated).unwrap(), b"leave");
        let recovered = read_record(&root).unwrap().unwrap();
        assert!(recovered.active.is_none());
        let restarted = DownloadJournal::begin(&root, &fixture).unwrap();
        assert_eq!(restarted.record.phase, JournalPhase::Media);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ready_recovery_finishes_rename_and_is_idempotent_after_rename() {
        for already_renamed in [false, true] {
            let root = prepare_root(if already_renamed {
                "ready-renamed"
            } else {
                "ready-part"
            });
            let token = "cccccccccccccccccccccccccccccccc";
            let final_path = root.join("_inbox").join("0000_inbox").join("asset02.mp4");
            let part = PathBuf::from(format!("{}.giv-{token}.part", final_path.to_string_lossy()));
            let mp4 = b"\x00\x00\x00\x08ftyp";
            let fixture = library("ready");
            let mut journal = DownloadJournal::begin(&root, &fixture).unwrap();
            journal
                .arm("asset02", ".mp4", token, mp4.len() as u64)
                .unwrap();
            fs::write(&part, mp4).unwrap();
            journal.mark_ready().unwrap();
            if already_renamed {
                fs::rename(&part, &final_path).unwrap();
            }
            drop(journal);

            assert!(matches!(
                DownloadJournal::recover(&root).unwrap(),
                RecoveryState::Ready
            ));
            assert_eq!(fs::read(&final_path).unwrap(), mp4);
            assert!(!part.exists());
            assert!(read_record(&root).unwrap().unwrap().active.is_none());
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn ready_recovery_preserves_both_files_on_conflict() {
        let root = prepare_root("ready-conflict");
        let token = "ffffffffffffffffffffffffffffffff";
        let final_path = root.join("_inbox").join("0000_inbox").join("asset05.jpg");
        let part = PathBuf::from(format!("{}.giv-{token}.part", final_path.to_string_lossy()));
        let fixture = library("conflict");
        let mut journal = DownloadJournal::begin(&root, &fixture).unwrap();
        journal.arm("asset05", ".jpg", token, 5).unwrap();
        fs::write(&part, b"new!!").unwrap();
        fs::write(&final_path, b"old!!").unwrap();
        journal.mark_ready().unwrap();
        drop(journal);

        assert!(DownloadJournal::recover(&root).is_err());
        assert_eq!(fs::read(&part).unwrap(), b"new!!");
        assert_eq!(fs::read(&final_path).unwrap(), b"old!!");
        assert_eq!(
            read_record(&root).unwrap().unwrap().active.unwrap().state,
            ActiveState::Ready
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ready_recovery_preserves_record_when_both_files_are_missing() {
        let root = prepare_root("ready-missing");
        let token = "abababababababababababababababab";
        let fixture = library("missing");
        let mut journal = DownloadJournal::begin(&root, &fixture).unwrap();
        journal.arm("asset06", ".jpg", token, 5).unwrap();
        journal.mark_ready().unwrap();
        drop(journal);

        assert!(DownloadJournal::recover(&root).is_err());
        assert_eq!(
            read_record(&root).unwrap().unwrap().active.unwrap().state,
            ActiveState::Ready
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn publishing_recovery_must_finish_before_a_new_run_begins() {
        let root = prepare_root("publishing");
        let fixture = library("publishing");
        let mut journal = DownloadJournal::begin(&root, &fixture).unwrap();
        let publish_library = journal.mark_publishing().unwrap();
        assert_eq!(publish_library.assets[0].id, fixture.assets[0].id);
        drop(journal);

        let RecoveryState::Publishing(recovered) = DownloadJournal::recover(&root).unwrap() else {
            panic!("publishing recovery expected");
        };
        assert_eq!(recovered.assets[0].id, fixture.assets[0].id);
        assert!(DownloadJournal::begin(&root, &fixture).is_err());
        assert_eq!(
            read_record(&root).unwrap().unwrap().phase,
            JournalPhase::Publishing
        );
        DownloadJournal::finish_recovered_publish(&root).unwrap();
        assert!(!snapshot_path(&root).exists());
        assert!(DownloadJournal::begin(&root, &fixture).is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn publishing_restart_uses_the_original_snapshot_not_a_new_manifest() {
        let root = prepare_root("publishing-snapshot");
        let original = library("original");
        let newly_fetched = library("new");
        let mut journal = DownloadJournal::begin(&root, &original).unwrap();
        journal.mark_publishing().unwrap();
        drop(journal);

        let RecoveryState::Publishing(recovered) = DownloadJournal::recover(&root).unwrap() else {
            panic!("publishing recovery expected");
        };
        assert_eq!(recovered.assets[0].id, original.assets[0].id);
        assert_ne!(recovered.assets[0].id, newly_fetched.assets[0].id);
        assert_eq!(recovered.assets[0].prompt, original.assets[0].prompt);

        DownloadJournal::finish_recovered_publish(&root).unwrap();
        assert!(!journal_path(&root).exists());
        assert!(!snapshot_path(&root).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_publishing_without_a_snapshot_fails_closed() {
        let root = prepare_root("legacy-publishing");
        fs::create_dir_all(root.join("_state")).unwrap();
        let value = serde_json::json!({
            "version": 1,
            "runToken": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "phase": "publishing",
            "active": null
        });
        fs::write(journal_path(&root), serde_json::to_vec(&value).unwrap()).unwrap();

        let error = DownloadJournal::recover(&root).unwrap_err();
        assert!(error.contains("没有受控清单快照"));
        assert!(journal_path(&root).is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn remove_error_is_success_when_readback_proves_absence() {
        let root = prepare_root("remove-late-error");
        fs::create_dir_all(root.join("_state")).unwrap();
        let path = journal_path(&root);
        fs::write(&path, b"record").unwrap();

        let result = remove_controlled_file(&root, &path, "测试记录", |path| {
            fs::remove_file(path)?;
            Err(std::io::Error::other("simulated SMB late error"))
        });
        assert!(result.is_ok());
        assert!(!path.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn snapshot_digest_or_content_mismatch_fails_closed() {
        let root = prepare_root("snapshot-mismatch");
        let fixture = library("snapshot");
        let mut journal = DownloadJournal::begin(&root, &fixture).unwrap();
        journal.mark_publishing().unwrap();
        fs::write(snapshot_path(&root), b"{}").unwrap();

        assert!(DownloadJournal::recover(&root).is_err());
        assert!(journal_path(&root).is_file());
        assert!(snapshot_path(&root).is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unknown_fields_fail_closed() {
        let root = prepare_root("unknown-field");
        fs::create_dir_all(root.join("_state")).unwrap();
        let value = serde_json::json!({
            "version": 1,
            "runToken": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "phase": "media",
            "active": null,
            "partPath": "C:\\not-trusted"
        });
        fs::write(journal_path(&root), serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(DownloadJournal::recover(&root).is_err());
        assert!(journal_path(&root).is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn journal_never_accepts_an_arbitrary_extension_or_token() {
        let root = prepare_root("validate");
        let fixture = library("validate");
        let mut journal = DownloadJournal::begin(&root, &fixture).unwrap();
        assert!(journal
            .arm("asset03", ".exe", "dddddddddddddddddddddddddddddddd", 5)
            .is_err());
        assert!(journal.arm("asset03", ".jpg", "../not-a-token", 5).is_err());
        assert!(journal
            .arm(
                "asset03",
                ".jpg",
                "dddddddddddddddddddddddddddddddd",
                MAX_MEDIA_BYTES + 1,
            )
            .is_err());
        let legacy_ready = ActiveMedia {
            asset_id: "asset03".into(),
            extension: ".jpg".into(),
            part_token: "dddddddddddddddddddddddddddddddd".into(),
            expected_size: 768 * 1024 * 1024,
            state: ActiveState::Ready,
        };
        assert!(legacy_ready.validate().is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn serialized_journal_does_not_contain_arbitrary_paths() {
        let root = prepare_root("schema");
        let fixture = library("schema");
        let mut journal = DownloadJournal::begin(&root, &fixture).unwrap();
        journal
            .arm("asset04", ".webm", "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", 5)
            .unwrap();
        let value: Value = serde_json::from_slice(&fs::read(journal_path(&root)).unwrap()).unwrap();
        let active = value["active"].as_object().unwrap();
        assert!(!active.contains_key("path"));
        assert!(!active.contains_key("partPath"));
        assert!(!active.contains_key("finalPath"));
        fs::remove_dir_all(root).unwrap();
    }
}
