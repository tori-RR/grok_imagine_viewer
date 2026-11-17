//! Explicit native-test isolation. This CLI mode can only use a marked fixture
//! containing its own copied executable and pre-created data directories.
use serde::Deserialize;
use std::{
    env,
    ffi::OsString,
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    sync::OnceLock,
};

#[derive(Debug, Clone)]
pub(crate) struct FixturePaths {
    pub(crate) root: PathBuf,
    pub(crate) config: PathBuf,
    pub(crate) data: PathBuf,
    pub(crate) gallery: Option<PathBuf>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Marker {
    schema: u8,
    owner: String,
    nonce: String,
}

static FIXTURE: OnceLock<Option<FixturePaths>> = OnceLock::new();

fn plain(path: &Path, directory: bool) -> Result<(), &'static str> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "native fixture path is unavailable")?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("native fixture links are forbidden");
        }
    }
    if metadata.file_type().is_symlink()
        || (directory && !metadata.is_dir())
        || (!directory && !metadata.is_file())
    {
        return Err("native fixture path has an invalid type");
    }
    Ok(())
}

fn validate(root: &Path, executable: &Path) -> Result<FixturePaths, &'static str> {
    if !root.is_absolute()
        || root
            .components()
            .any(|c| matches!(c, Component::CurDir | Component::ParentDir))
        || !root
            .file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with("giv-desktop-smoke-"))
    {
        return Err("native fixture must be an absolute registered smoke directory");
    }
    for parent in root.ancestors() {
        plain(parent, true)?;
    }
    let marker_path = root.join(".giv-smoke-owner.json");
    plain(&marker_path, false)?;
    let mut marker_bytes = Vec::new();
    fs::File::open(&marker_path)
        .map_err(|_| "native fixture marker is unreadable")?
        .take(1025)
        .read_to_end(&mut marker_bytes)
        .map_err(|_| "native fixture marker is unreadable")?;
    if marker_bytes.len() > 1024 {
        return Err("native fixture marker is invalid");
    }
    let marker: Marker =
        serde_json::from_slice(&marker_bytes).map_err(|_| "native fixture marker is invalid")?;
    // Packagers verify this capability without executing an unknown older EXE.
    // Keep a real byte string even when release LTO folds constant comparisons.
    if marker.schema != 1
        || marker.owner != std::hint::black_box("grok-imagine-viewer-native-smoke")
        || marker.nonce.len() != 32
        || !marker
            .nonce
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err("native fixture ownership is invalid");
    }
    for name in [
        "program",
        "config",
        "data",
        "profiles",
        "profiles/gallery-webview2",
        "profiles/grok-webview2",
        "gallery",
    ] {
        plain(&root.join(name), true)?;
    }
    let expected = root.join("program/grok-imagine-viewer-tauri.exe");
    plain(&expected, false)?;
    plain(executable, false)?;
    let expected = expected
        .canonicalize()
        .map_err(|_| "native fixture program identity is unavailable")?;
    let actual = executable
        .canonicalize()
        .map_err(|_| "native fixture program identity is unavailable")?;
    if expected != actual {
        return Err("native fixture must run its own copied program");
    }
    let config = root.join("config");
    plain(&config.join(".viewer-config.json"), false)?;
    Ok(FixturePaths {
        root: root.to_owned(),
        config,
        data: root.join("data"),
        gallery: None,
    })
}

fn parse(args: &[OsString], executable: &Path) -> Result<Option<FixturePaths>, &'static str> {
    let fixture_requested = args.iter().any(|arg| {
        let arg = arg.to_string_lossy();
        arg == "--smoke-fixture" || arg.starts_with("--smoke-fixture=")
    });
    let mut root = None;
    let mut requested_gallery = None;
    let mut gallery_arguments = 0;
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].to_string_lossy();
        if arg == "--smoke-fixture" {
            if root.is_some() || index + 1 >= args.len() {
                return Err("native fixture argument is invalid");
            }
            index += 1;
            root = Some(PathBuf::from(&args[index]));
        } else if let Some(value) = arg.strip_prefix("--smoke-fixture=") {
            if root.is_some() {
                return Err("native fixture argument is invalid");
            }
            root = Some(PathBuf::from(value));
        } else if arg == "--root" {
            gallery_arguments += 1;
            index += 1;
            if index >= args.len() {
                return Err("gallery root argument is missing");
            }
            requested_gallery = Some(PathBuf::from(&args[index]));
        } else if let Some(value) = arg.strip_prefix("--root=") {
            gallery_arguments += 1;
            requested_gallery = Some(PathBuf::from(value));
        }
        index += 1;
    }
    let Some(root) = root else {
        return if fixture_requested {
            Err("native fixture flag was consumed as another argument")
        } else {
            Ok(None)
        };
    };
    if gallery_arguments > 1 {
        return Err("native fixture gallery argument is repeated");
    }
    let mut paths = validate(&root, executable)?;
    if let Some(gallery) = requested_gallery {
        let selected = gallery
            .canonicalize()
            .map_err(|_| "native fixture gallery is unavailable")?;
        let expected = root
            .join("gallery")
            .canonicalize()
            .map_err(|_| "native fixture gallery is unavailable")?;
        if selected != expected {
            return Err("native smoke cannot select a gallery outside its fixture");
        }
        paths.gallery = Some(root.join("gallery"));
    }
    Ok(Some(paths))
}

pub(crate) fn initialize() -> Result<(), &'static str> {
    let args: Vec<_> = env::args_os().skip(1).collect();
    let executable = env::current_exe().map_err(|_| "application executable is unavailable")?;
    let paths = parse(&args, &executable)?;
    FIXTURE
        .set(paths)
        .map_err(|_| "native fixture was initialized twice")
}

pub(crate) fn current() -> Option<&'static FixturePaths> {
    FIXTURE.get().and_then(Option::as_ref)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (PathBuf, PathBuf) {
        let nonce = format!(
            "{:032x}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let root = env::temp_dir().join(format!("giv-desktop-smoke-{nonce}"));
        fs::create_dir(&root).unwrap();
        for name in [
            "program",
            "config",
            "data",
            "profiles/gallery-webview2",
            "profiles/grok-webview2",
            "gallery",
        ] {
            fs::create_dir_all(root.join(name)).unwrap();
        }
        fs::write(
            root.join(".giv-smoke-owner.json"),
            format!(
                r#"{{"schema":1,"owner":"grok-imagine-viewer-native-smoke","nonce":"{nonce}"}}"#
            ),
        )
        .unwrap();
        fs::write(root.join("config/.viewer-config.json"), b"{}").unwrap();
        let exe = root.join("program/grok-imagine-viewer-tauri.exe");
        fs::write(&exe, b"fixture executable").unwrap();
        (root, exe)
    }
    #[test]
    fn normal_launch_has_no_fixture_override() {
        assert!(parse(&[], Path::new("not-opened.exe")).unwrap().is_none());
        for args in [
            vec!["--root".into(), "--smoke-fixture".into(), "unopened".into()],
            vec!["--root".into(), "--smoke-fixture=unopened".into()],
        ] {
            assert!(parse(&args, Path::new("not-opened.exe")).is_err());
        }
    }
    #[test]
    fn marked_fixture_isolates_every_application_directory() {
        let (root, exe) = fixture();
        let result = validate(&root, &exe).unwrap();
        assert_eq!(result.config, root.join("config"));
        assert_eq!(result.data, root.join("data"));
        assert!(parse(
            &[
                "--smoke-fixture".into(),
                root.clone().into_os_string(),
                "--root".into(),
                root.join("gallery").into_os_string()
            ],
            &exe
        )
        .unwrap()
        .is_some());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn unmarked_wrong_program_and_escaping_gallery_are_refused() {
        let (root, exe) = fixture();
        assert!(parse(
            &[
                "--smoke-fixture".into(),
                root.clone().into_os_string(),
                "--root".into(),
                root.join("data").into_os_string()
            ],
            &exe
        )
        .is_err());
        assert!(validate(&root, Path::new("outside.exe")).is_err());
        fs::remove_file(root.join(".giv-smoke-owner.json")).unwrap();
        assert!(validate(&root, &exe).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn wrong_owner_invalid_schema_and_repeated_flags_are_refused() {
        let (root, exe) = fixture();
        assert!(parse(
            &[
                "--smoke-fixture".into(),
                root.clone().into_os_string(),
                "--smoke-fixture".into(),
                root.clone().into_os_string()
            ],
            &exe
        )
        .is_err());
        for values in [
            vec![
                "--root".into(),
                root.join("data").into_os_string(),
                "--root".into(),
                root.join("gallery").into_os_string(),
            ],
            vec![
                format!("--root={}", root.join("data").display()).into(),
                "--root".into(),
                root.join("gallery").into_os_string(),
            ],
            vec![
                "--root".into(),
                root.join("gallery").into_os_string(),
                format!("--root={}", root.join("data").display()).into(),
            ],
        ] {
            let mut args = vec!["--smoke-fixture".into(), root.clone().into_os_string()];
            args.extend(values);
            assert!(parse(&args, &exe).is_err());
        }
        fs::write(
            root.join(".giv-smoke-owner.json"),
            br#"{"schema":2,"owner":"other","nonce":"00000000000000000000000000000000"}"#,
        )
        .unwrap();
        assert!(validate(&root, &exe).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
