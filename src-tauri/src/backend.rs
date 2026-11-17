use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::env;
use std::error::Error;
use std::ffi::{OsStr, OsString};
use std::fmt;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream};
#[cfg(windows)]
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{
    mpsc::{self, Receiver},
    Arc,
};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{webview::Cookie, AppHandle, Manager};
use url::Url;

const DESKTOP_AUTH_PROTOCOL: u8 = 3;
const START_TIMEOUT: Duration = Duration::from_secs(15);
const HTTP_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_HTTP_BYTES: u64 = 256 * 1024;

#[derive(Debug, Clone, Copy)]
pub struct LaunchError(&'static str);

impl fmt::Display for LaunchError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.0)
    }
}

impl Error for LaunchError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Ownership {
    Owned,
    Shared,
}

#[derive(Debug)]
struct Banner {
    ownership: Ownership,
    url: Url,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ViewerConfig {
    app: String,
    static_dir: String,
    config_path: String,
    #[serde(default)]
    root: Option<String>,
    #[serde(default)]
    download_bind_only: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopBootstrap {
    protocol_version: u8,
    instance_secret: String,
    session_token: String,
    instance_id: String,
    server_path: String,
    static_dir: String,
    config_path: String,
    desktop: String,
    language: String,
    root: String,
    tool_dirs: Vec<String>,
    download_bind_only: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ViewerIdentity {
    app: String,
    protocol_version: u8,
    instance_id: String,
    pid: u32,
    port: u16,
    server_path: String,
    static_dir: String,
    config_path: String,
    download_bind_only: bool,
    challenge_response: String,
}

struct BackendSessionInner {
    url: Url,
    session_token: String,
    instance_secret: [u8; 32],
    instance_id: [u8; 16],
    server_path: PathBuf,
    static_dir: PathBuf,
    config_path: PathBuf,
}

#[derive(Clone)]
pub(crate) struct BackendSession {
    inner: Arc<BackendSessionInner>,
}

impl BackendSession {
    #[cfg(windows)]
    pub(crate) fn native_download_request(&self, agent: &ureq::Agent, method: &str, path: &str) -> Result<ureq::Request, String> {
        let upload = path.strip_prefix("upload/").is_some_and(|id| id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
        let allowed = method == "GET" && path == "status" || method == "POST" && (matches!(path, "reserve" | "prompt-targets" | "start" | "stop" | "authorize" | "failure") || upload);
        if !allowed || !is_exact_loopback_base(self.url()) { return Err("原生下载端点校验失败。".into()); }
        let origin = self.url().origin().ascii_serialization();
        Ok(agent.request(method, &format!("{origin}/internal/download/{path}"))
            .set("X-Giv-Admin", &encode_hex(&self.inner.instance_secret))
            .set("Origin", &origin).set("Accept", "application/json"))
    }

    pub(crate) fn url(&self) -> &Url {
        &self.inner.url
    }

    pub(crate) fn verify_identity(&self) -> bool {
        verify_identity(self)
    }

    pub(crate) fn gallery_cookie(&self) -> Result<Cookie<'static>, LaunchError> {
        let port = self
            .inner
            .url
            .port()
            .ok_or(LaunchError("local gallery cookie is invalid"))?;
        Cookie::parse(format!(
            "GIV_SESSION_{port}={}; Domain=127.0.0.1; Path=/; HttpOnly; SameSite=Strict",
            self.inner.session_token
        ))
        .map(Cookie::into_owned)
        .map_err(|_| LaunchError("local gallery cookie is invalid"))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DownloadBindOutcome {
    Bound(PathBuf),
    AccountMismatch,
    UnsupportedMode,
    RootChanged,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadBindRequest<'a> {
    expected_root: &'a str,
    grok_user_id: &'a str,
    commit: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DownloadBindResponse {
    ok: bool,
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    root: Option<String>,
}

pub struct ServerLease {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    #[cfg(windows)]
    job: Option<OwnedHandle>,
    session: BackendSession,
}

impl ServerLease {
    pub fn start(app: &AppHandle) -> Result<Self, LaunchError> {
        let viewer_dir = viewer_dir(app)?;
        let server_path = sidecar_path(&viewer_dir);
        let static_dir = static_dir(&viewer_dir);
        if !server_path.is_file() || !static_dir.is_dir() {
            return Err(LaunchError("application resource layout is incomplete"));
        }

        let config_dir = if let Some(fixture) = crate::local_fixture::current() { fixture.config.clone() } else { app
            .path()
            .app_config_dir()
            .map_err(|_| LaunchError("application config directory is unavailable"))? };
        fs::create_dir_all(&config_dir)
            .map_err(|_| LaunchError("application config directory is unavailable"))?;
        let config_path = config_dir.join(".viewer-config.json");
        ensure_config_file(&config_path)?;

        let desktop_dir = if let Some(fixture) = crate::local_fixture::current() { fixture.data.clone() } else { app
            .path()
            .app_data_dir()
            .map_err(|_| LaunchError("application data directory is unavailable"))? };
        fs::create_dir_all(&desktop_dir)
            .map_err(|_| LaunchError("application data directory is unavailable"))?;

        let instance_secret = random_bytes::<32>()?;
        let session_token_bytes = random_bytes::<32>()?;
        let instance_id = random_bytes::<16>()?;
        let root = if let Some(fixture) = crate::local_fixture::current() {
            fixture.gallery.as_ref().map(|path| path.to_string_lossy().into_owned()).unwrap_or_default()
        } else { requested_root()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_default() };
        let bootstrap = DesktopBootstrap {
            protocol_version: DESKTOP_AUTH_PROTOCOL,
            instance_secret: encode_hex(&instance_secret),
            session_token: encode_hex(&session_token_bytes),
            instance_id: encode_hex(&instance_id),
            server_path: server_path.to_string_lossy().into_owned(),
            static_dir: static_dir.to_string_lossy().into_owned(),
            config_path: config_path.to_string_lossy().into_owned(),
            desktop: desktop_dir.to_string_lossy().into_owned(),
            language: "auto".to_owned(),
            root,
            tool_dirs: Vec::new(),
            download_bind_only: true,
        };
        let mut bootstrap_line = serde_json::to_vec(&bootstrap)
            .map_err(|_| LaunchError("local gallery authentication could not start"))?;
        bootstrap_line.push(b'\n');

        let mut command = Command::new(&server_path);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        prepare_owned_server_command(&mut command);

        #[cfg(windows)]
        let (mut child, job) = spawn_owned_server(&mut command)?;
        #[cfg(not(windows))]
        let mut child = command
            .spawn()
            .map_err(|_| LaunchError("Go gallery service could not start"))?;

        let mut stdin = match child.stdin.take() {
            Some(stdin) => stdin,
            None => {
                terminate_child(&mut child);
                return Err(LaunchError("Go gallery authentication could not start"));
            }
        };
        if stdin.write_all(&bootstrap_line).is_err() {
            terminate_child(&mut child);
            return Err(LaunchError("Go gallery authentication could not start"));
        }
        let stdout = match child.stdout.take() {
            Some(stdout) => stdout,
            None => {
                terminate_child(&mut child);
                return Err(LaunchError("Go gallery service did not expose readiness output"));
            }
        };
        if let Some(stderr) = child.stderr.take() {
            thread::spawn(move || {
                let mut reader = BufReader::new(stderr);
                let _ = std::io::copy(&mut reader, &mut std::io::sink());
            });
        }
        let banners = drain_stdout(stdout);
        let banner = match banners.recv_timeout(START_TIMEOUT) {
            Ok(banner) => banner,
            Err(_) => {
                terminate_child(&mut child);
                return Err(LaunchError("Go gallery service did not become ready"));
            }
        };

        match banner.ownership {
            Ownership::Owned => {
                if !child_is_running(&mut child) {
                    terminate_child(&mut child);
                    return Err(LaunchError("Go gallery service exited during startup"));
                }
                let session = BackendSession {
                    inner: Arc::new(BackendSessionInner {
                        url: banner.url,
                        session_token: bootstrap.session_token,
                        instance_secret,
                        instance_id,
                        server_path,
                        static_dir,
                        config_path,
                    }),
                };
                if !validate_with_retry(&session) {
                    terminate_child(&mut child);
                    return Err(LaunchError("Go gallery service identity check failed"));
                }
                Ok(Self {
                    child: Some(child),
                    stdin: Some(stdin),
                    #[cfg(windows)]
                    job: Some(job),
                    session,
                })
            }
            Ownership::Shared => {
                terminate_child(&mut child);
                Err(LaunchError("refusing an unowned local gallery service"))
            }
        }
    }

    pub(crate) fn session(&self) -> &BackendSession {
        &self.session
    }
}

impl Drop for ServerLease {
    fn drop(&mut self) {
        // Go watches stdin EOF as its graceful shutdown signal. Keep this pipe
        // open for the entire backend lifetime, then close it before fallback
        // termination so in-flight downloads can stop and journals can flush.
        drop(self.stdin.take());
        if let Some(mut child) = self.child.take() {
            if !wait_for_exit(&mut child, Duration::from_secs(15)) {
                terminate_child(&mut child);
            }
        }
        #[cfg(windows)]
        drop(self.job.take());
    }
}

fn viewer_dir(app: &AppHandle) -> Result<PathBuf, LaunchError> {
    if cfg!(debug_assertions) {
        return Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(Path::to_path_buf)
            .ok_or(LaunchError("application resource layout is incomplete"));
    }
    app.path()
        .resource_dir()
        .map(|path| path.join("viewer"))
        .map_err(|_| LaunchError("application resource directory is unavailable"))
}

fn static_dir(viewer_dir: &Path) -> PathBuf {
    if cfg!(debug_assertions) {
        viewer_dir.join("frontend-react").join("dist")
    } else {
        viewer_dir.join("static")
    }
}

fn sidecar_path(viewer_dir: &Path) -> PathBuf {
    let filename = if cfg!(windows) {
        "giv-backend.exe"
    } else {
        "giv-backend"
    };
    if cfg!(debug_assertions) {
        viewer_dir.join("backend-go").join("bin").join(filename)
    } else {
        viewer_dir.join(filename)
    }
}

fn ensure_config_file(path: &Path) -> Result<(), LaunchError> {
    if path.is_file() {
        return Ok(());
    }
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| LaunchError("application configuration could not be initialized"))?;
    file.write_all(b"{}\n")
        .and_then(|_| file.sync_all())
        .map_err(|_| LaunchError("application configuration could not be initialized"))
}

fn requested_root() -> Option<OsString> {
    let mut args = env::args_os().skip(1);
    while let Some(arg) = args.next() {
        if arg == OsStr::new("--root") {
            return args.next();
        }
        let text = arg.to_string_lossy();
        if let Some(value) = text.strip_prefix("--root=") {
            if !value.is_empty() {
                return Some(OsString::from(value));
            }
        }
    }
    None
}


#[cfg(test)]
fn wait_for_success_or_terminate(child: &mut Child, timeout: Duration) -> bool {
    if !wait_for_exit(child, timeout) {
        terminate_child(child);
        return false;
    }
    match child.try_wait() {
        Ok(Some(status)) => status.success(),
        Ok(None) | Err(_) => {
            terminate_child(child);
            false
        }
    }
}

fn drain_stdout(stdout: impl Read + Send + 'static) -> Receiver<Banner> {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut sent = false;
        for line in reader.lines().map_while(Result::ok) {
            if !sent {
                if let Some(banner) = parse_banner(&line) {
                    sent = sender.send(banner).is_ok();
                }
            }
        }
    });
    receiver
}

fn parse_banner(line: &str) -> Option<Banner> {
    // Go Sidecar emits a single JSON readiness record. The record is only a
    // locator; ownership is still established by the child handle and the
    // independent nonce/HMAC challenge in validate_with_retry().
    if let Ok(ready) = serde_json::from_str::<serde_json::Value>(line) {
        if ready.get("app").and_then(serde_json::Value::as_str) == Some("giv-go") {
            let raw_url = ready.get("origin").and_then(serde_json::Value::as_str)?;
            let url = Url::parse(raw_url).ok()?;
            if !is_exact_loopback_base(&url) {
                return None;
            }
            return Some(Banner { ownership: Ownership::Owned, url });
        }
    }

    let (ownership, raw_url) = if let Some(url) = line.strip_prefix("grok_imagine_viewer  ") {
        (Ownership::Owned, url)
    } else {
        let url = line.strip_prefix("already running  ")?;
        (Ownership::Shared, url)
    };
    let url = Url::parse(raw_url).ok()?;
    if !is_exact_loopback_base(&url) {
        return None;
    }
    Some(Banner { ownership, url })
}

fn is_exact_loopback_base(url: &Url) -> bool {
    url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port().is_some()
        && url.path() == "/"
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
}

pub fn same_origin(expected: &Url, candidate: &Url) -> bool {
    expected.scheme() == candidate.scheme()
        && expected.host_str() == candidate.host_str()
        && expected.port_or_known_default() == candidate.port_or_known_default()
}

fn random_bytes<const N: usize>() -> Result<[u8; N], LaunchError> {
    let mut bytes = [0_u8; N];
    getrandom::fill(&mut bytes)
        .map_err(|_| LaunchError("local gallery authentication could not start"))?;
    Ok(bytes)
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut value = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        value.push(HEX[(byte >> 4) as usize] as char);
        value.push(HEX[(byte & 0x0f) as usize] as char);
    }
    value
}

fn decode_lower_hex<const N: usize>(value: &str) -> Option<[u8; N]> {
    if value.len() != N * 2
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return None;
    }
    let mut output = [0_u8; N];
    let bytes = value.as_bytes();
    for (index, slot) in output.iter_mut().enumerate() {
        let high = (bytes[index * 2] as char).to_digit(16)? as u8;
        let low = (bytes[index * 2 + 1] as char).to_digit(16)? as u8;
        *slot = (high << 4) | low;
    }
    Some(output)
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut key_block = [0_u8; 64];
    if key.len() > key_block.len() {
        let digest = Sha256::digest(key);
        key_block[..digest.len()].copy_from_slice(&digest);
    } else {
        key_block[..key.len()].copy_from_slice(key);
    }
    let mut inner_pad = [0x36_u8; 64];
    let mut outer_pad = [0x5c_u8; 64];
    for index in 0..key_block.len() {
        inner_pad[index] ^= key_block[index];
        outer_pad[index] ^= key_block[index];
    }
    let mut inner = Sha256::new();
    inner.update(inner_pad);
    inner.update(message);
    let inner_digest = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(outer_pad);
    outer.update(inner_digest);
    let digest = outer.finalize();
    let mut output = [0_u8; 32];
    output.copy_from_slice(&digest);
    output
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn identity_message(
    challenge: &[u8; 32],
    instance_id: &[u8; 16],
    port: u16,
    pid: u32,
    download_bind_only: bool,
) -> Vec<u8> {
    let mut message = Vec::with_capacity(16 + 32 + 16 + 2 + 4 + 1);
    message.extend_from_slice(b"giv-identity-v3\0");
    message.extend_from_slice(challenge);
    message.extend_from_slice(instance_id);
    message.extend_from_slice(&port.to_be_bytes());
    message.extend_from_slice(&pid.to_be_bytes());
    message.push(u8::from(download_bind_only));
    message
}

fn validate_with_retry(session: &BackendSession) -> bool {
    let deadline = Instant::now() + HTTP_TIMEOUT;
    loop {
        if session.verify_identity()
            && fetch_config(session).is_some_and(|config| {
                config.app == "grok_imagine_viewer"
                    && config.download_bind_only
                    && same_path(Path::new(&config.static_dir), &session.inner.static_dir)
                    && same_path(Path::new(&config.config_path), &session.inner.config_path)
            })
        {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn http_get(url: &Url, path: &str, headers: &[(&str, &str)]) -> Option<Vec<u8>> {
    if !is_exact_loopback_base(url) || !path.starts_with('/') || path.contains(['\r', '\n']) {
        return None;
    }
    let port = url.port()?;
    let address = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port));
    let mut stream = TcpStream::connect_timeout(&address, HTTP_TIMEOUT).ok()?;
    stream.set_read_timeout(Some(HTTP_TIMEOUT)).ok()?;
    stream.set_write_timeout(Some(HTTP_TIMEOUT)).ok()?;
    let mut request =
        format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept: application/json\r\n");
    for (name, value) in headers {
        if name.is_empty()
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            || value.contains(['\r', '\n'])
        {
            return None;
        }
        request.push_str(name);
        request.push_str(": ");
        request.push_str(value);
        request.push_str("\r\n");
    }
    request.push_str("Connection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).ok()?;

    let mut response = Vec::new();
    stream
        .take(MAX_HTTP_BYTES + 1)
        .read_to_end(&mut response)
        .ok()?;
    if response.len() as u64 > MAX_HTTP_BYTES {
        return None;
    }
    let (status, body) = parse_http_response(&response)?;
    if status != 200 {
        return None;
    }
    Some(body.to_vec())
}

fn fetch_config(session: &BackendSession) -> Option<ViewerConfig> {
    let body = http_get(
        session.url(),
        "/api/config?minimal=1",
        &[("X-Viewer-Session", &session.inner.session_token)],
    )?;
    serde_json::from_slice(&body).ok()
}

fn verify_identity(session: &BackendSession) -> bool {
    let Ok(challenge) = random_bytes::<32>() else {
        return false;
    };
    let challenge_hex = encode_hex(&challenge);
    let Some(body) = http_get(
        session.url(),
        "/api/identity",
        &[("X-Viewer-Challenge", &challenge_hex)],
    ) else {
        return false;
    };
    let Ok(identity) = serde_json::from_slice::<ViewerIdentity>(&body) else {
        return false;
    };
    identity_is_valid(session, &challenge, &identity)
}

fn identity_is_valid(
    session: &BackendSession,
    challenge: &[u8; 32],
    identity: &ViewerIdentity,
) -> bool {
    if identity.app != "grok_imagine_viewer"
        || identity.protocol_version != DESKTOP_AUTH_PROTOCOL
        || !identity.download_bind_only
        || identity.pid == 0
        || identity.port != session.url().port().unwrap_or_default()
        || !same_path(Path::new(&identity.server_path), &session.inner.server_path)
        || !same_path(Path::new(&identity.static_dir), &session.inner.static_dir)
        || !same_path(Path::new(&identity.config_path), &session.inner.config_path)
    {
        return false;
    }
    let Some(instance_id) = decode_lower_hex::<16>(&identity.instance_id) else {
        return false;
    };
    if !constant_time_eq(&instance_id, &session.inner.instance_id) {
        return false;
    }
    let Some(response) = decode_lower_hex::<32>(&identity.challenge_response) else {
        return false;
    };
    let message = identity_message(
        challenge,
        &session.inner.instance_id,
        identity.port,
        identity.pid,
        identity.download_bind_only,
    );
    let expected = hmac_sha256(&session.inner.instance_secret, &message);
    constant_time_eq(&response, &expected)
}

fn parse_http_response(response: &[u8]) -> Option<(u16, &[u8])> {
    let header_end = response.windows(4).position(|part| part == b"\r\n\r\n")?;
    let headers = std::str::from_utf8(&response[..header_end]).ok()?;
    let body = &response[(header_end + 4)..];
    let mut lines = headers.split("\r\n");
    let mut status_parts = lines.next()?.split_ascii_whitespace();
    if status_parts.next()? != "HTTP/1.1" {
        return None;
    }
    let status = status_parts.next()?.parse::<u16>().ok()?;
    status_parts.next()?;
    let mut content_length = None;
    for line in lines {
        let (name, value) = line.split_once(':')?;
        if name.eq_ignore_ascii_case("content-length") {
            if content_length.is_some() {
                return None;
            }
            content_length = value.trim().parse::<usize>().ok();
        }
    }
    if content_length != Some(body.len()) {
        return None;
    }
    Some((status, body))
}

pub(crate) fn bind_download_account(
    session: &BackendSession,
    expected_root: &Path,
    user_id: &str,
    commit: bool,
) -> Result<DownloadBindOutcome, LaunchError> {
    let url = session.url();
    if !is_exact_loopback_base(url) {
        return Err(LaunchError(
            "local gallery service URL is not an exact loopback origin",
        ));
    }
    let expected_root = expected_root.to_str().ok_or(LaunchError(
        "gallery path cannot be encoded for account binding",
    ))?;
    if user_id.trim().is_empty() || user_id.trim() != user_id {
        return Err(LaunchError("Grok account binding identifier is invalid"));
    }
    if !session.verify_identity() {
        return Err(LaunchError("local gallery service identity check failed"));
    }
    let port = url
        .port()
        .ok_or(LaunchError("local gallery service port is unavailable"))?;
    let body = serde_json::to_vec(&DownloadBindRequest {
        expected_root,
        grok_user_id: user_id,
        commit,
    })
    .map_err(|_| LaunchError("local gallery account binding request is invalid"))?;
    let address = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port));
    let mut stream = TcpStream::connect_timeout(&address, HTTP_TIMEOUT)
        .map_err(|_| LaunchError("local gallery account binding is unavailable"))?;
    stream
        .set_read_timeout(Some(HTTP_TIMEOUT))
        .map_err(|_| LaunchError("local gallery account binding is unavailable"))?;
    stream
        .set_write_timeout(Some(HTTP_TIMEOUT))
        .map_err(|_| LaunchError("local gallery account binding is unavailable"))?;
    let request = format!(
        "PUT /api/download/bind HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: http://127.0.0.1:{port}\r\nX-Viewer-Session: {}\r\nAccept: application/json\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        session.inner.session_token,
        body.len(),
    );
    stream
        .write_all(request.as_bytes())
        .and_then(|_| stream.write_all(&body))
        .map_err(|_| LaunchError("local gallery account binding is unavailable"))?;

    let mut response = Vec::new();
    stream
        .take(MAX_HTTP_BYTES + 1)
        .read_to_end(&mut response)
        .map_err(|_| LaunchError("local gallery account binding is unavailable"))?;
    if response.len() as u64 > MAX_HTTP_BYTES {
        return Err(LaunchError(
            "local gallery account binding response is too large",
        ));
    }
    let (status, body) = parse_http_response(&response).ok_or(LaunchError(
        "local gallery account binding response is invalid",
    ))?;
    download_bind_from_response(status, body, Path::new(expected_root))
}

fn download_bind_from_response(
    status: u16,
    body: &[u8],
    expected_root: &Path,
) -> Result<DownloadBindOutcome, LaunchError> {
    let response: DownloadBindResponse = serde_json::from_slice(body)
        .map_err(|_| LaunchError("local gallery account binding response is invalid"))?;
    if status == 200 && response.ok {
        let root = response
            .root
            .filter(|root| !root.trim().is_empty())
            .map(PathBuf::from)
            .ok_or(LaunchError(
                "local gallery account binding response is invalid",
            ))?;
        if !same_path(&root, expected_root) {
            return Err(LaunchError(
                "local gallery account binding returned another root",
            ));
        }
        let root =
            fs::canonicalize(root).map_err(|_| LaunchError("bound gallery root is unavailable"))?;
        return Ok(DownloadBindOutcome::Bound(root));
    }
    if response.ok || status != 409 {
        return Err(LaunchError("local gallery account binding failed"));
    }
    match response.code.as_deref() {
        Some("account_mismatch") => Ok(DownloadBindOutcome::AccountMismatch),
        Some("unsupported_mode") => Ok(DownloadBindOutcome::UnsupportedMode),
        Some("library_changed") => Ok(DownloadBindOutcome::RootChanged),
        _ => Err(LaunchError("local gallery account binding failed")),
    }
}

pub(crate) fn current_gallery_root(
    session: &BackendSession,
) -> Result<Option<PathBuf>, LaunchError> {
    let url = session.url();
    if !is_exact_loopback_base(url) {
        return Err(LaunchError(
            "local gallery service URL is not an exact loopback origin",
        ));
    }
    if !session.verify_identity() {
        return Err(LaunchError("local gallery service identity check failed"));
    }
    let config = fetch_config(session).ok_or(LaunchError(
        "local gallery service configuration is unavailable",
    ))?;
    gallery_root_from_config(config)
}

fn gallery_root_from_config(config: ViewerConfig) -> Result<Option<PathBuf>, LaunchError> {
    if config.app != "grok_imagine_viewer" || !config.download_bind_only {
        return Err(LaunchError("local gallery service identity check failed"));
    }
    Ok(config.root.and_then(|root| {
        if root.trim().is_empty() {
            None
        } else {
            Some(PathBuf::from(root))
        }
    }))
}

fn same_path(left: &Path, right: &Path) -> bool {
    normalize_path(left) == normalize_path(right)
}

fn normalize_path(path: &Path) -> String {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };
    let resolved = fs::canonicalize(&absolute).unwrap_or_else(|_| {
        let Some(parent) = absolute.parent() else {
            return absolute.clone();
        };
        let Some(name) = absolute.file_name() else {
            return absolute.clone();
        };
        fs::canonicalize(parent)
            .map(|canonical_parent| canonical_parent.join(name))
            .unwrap_or(absolute.clone())
    });
    let replaced = resolved.to_string_lossy().replace('\\', "/");
    let mut normalized = if let Some(rest) = replaced.strip_prefix("//?/UNC/") {
        format!("//{rest}")
    } else if let Some(rest) = replaced.strip_prefix("//?/") {
        rest.to_owned()
    } else {
        replaced
    };
    if cfg!(windows) {
        normalized.make_ascii_lowercase();
    }
    while normalized.len() > 1 && normalized.ends_with('/') {
        normalized.pop();
    }
    normalized
}

fn child_is_running(child: &mut Child) -> bool {
    child.try_wait().ok().flatten().is_none()
}

fn wait_for_exit(child: &mut Child, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            _ => return false,
        }
    }
}

#[cfg(windows)]
fn prepare_owned_server_command(command: &mut Command) {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CREATE_SUSPENDED: u32 = 0x0000_0004;
    command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
}

#[cfg(not(windows))]
fn prepare_owned_server_command(command: &mut Command) {
    hide_child_window(command);
}

#[cfg(windows)]
fn owned_win32_handle(handle: windows::Win32::Foundation::HANDLE) -> OwnedHandle {
    // SAFETY: each caller passes a newly-created owned Win32 handle exactly once.
    unsafe { OwnedHandle::from_raw_handle(handle.0) }
}

#[cfg(windows)]
fn win32_handle(handle: &OwnedHandle) -> windows::Win32::Foundation::HANDLE {
    windows::Win32::Foundation::HANDLE(handle.as_raw_handle())
}

#[cfg(windows)]
fn create_server_job() -> Result<OwnedHandle, LaunchError> {
    use std::mem::size_of;
    use windows::core::PCWSTR;
    use windows::Win32::System::JobObjects::{
        CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    // SAFETY: null security/name arguments request an unnamed job with default security.
    let raw = unsafe { CreateJobObjectW(None, PCWSTR::null()) }
        .map_err(|_| LaunchError("local gallery process job could not be created"))?;
    let job = owned_win32_handle(raw);
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    // SAFETY: `limits` is the exact structure required by this information class
    // and remains alive for the duration of the call.
    unsafe {
        SetInformationJobObject(
            win32_handle(&job),
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    }
    .map_err(|_| LaunchError("local gallery process job could not be configured"))?;
    Ok(job)
}

#[cfg(windows)]
fn resume_suspended_process(process_id: u32) -> Result<(), LaunchError> {
    use std::mem::size_of;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows::Win32::System::Threading::{
        GetProcessIdOfThread, OpenThread, ResumeThread, THREAD_QUERY_LIMITED_INFORMATION,
        THREAD_SUSPEND_RESUME,
    };

    // The program has not executed yet, so its only thread is the primary thread
    // created by CreateProcess. Enumerating it avoids undocumented NtResumeProcess.
    let raw_snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) }
        .map_err(|_| LaunchError("local gallery suspended process could not be inspected"))?;
    let snapshot = owned_win32_handle(raw_snapshot);
    let mut entry = THREADENTRY32 {
        dwSize: size_of::<THREADENTRY32>() as u32,
        ..Default::default()
    };
    // SAFETY: `entry` has the required size and both handles remain valid.
    unsafe { Thread32First(win32_handle(&snapshot), &mut entry) }
        .map_err(|_| LaunchError("local gallery suspended process could not be inspected"))?;
    let thread_id = loop {
        if entry.th32OwnerProcessID == process_id {
            break entry.th32ThreadID;
        }
        if unsafe { Thread32Next(win32_handle(&snapshot), &mut entry) }.is_err() {
            return Err(LaunchError(
                "local gallery suspended process thread was not found",
            ));
        }
    };
    // SAFETY: the thread id came from a live system snapshot for this child.
    let raw_thread = unsafe {
        OpenThread(
            THREAD_SUSPEND_RESUME | THREAD_QUERY_LIMITED_INFORMATION,
            false,
            thread_id,
        )
    }
    .map_err(|_| LaunchError("local gallery suspended process could not resume"))?;
    let thread = owned_win32_handle(raw_thread);
    // The system-wide snapshot can race with external termination and TID
    // reuse. Holding the opened handle pins the thread object; verify its live
    // owner before changing the suspend count.
    if unsafe { GetProcessIdOfThread(win32_handle(&thread)) } != process_id {
        return Err(LaunchError(
            "local gallery suspended process thread identity changed",
        ));
    }
    // CREATE_SUSPENDED produces a suspend count of exactly one. Any other value
    // means the no-execution-before-assignment guarantee cannot be established.
    let previous = unsafe { ResumeThread(win32_handle(&thread)) };
    if previous != 1 {
        return Err(LaunchError(
            "local gallery suspended process could not resume",
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn terminate_suspended_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(windows)]
fn spawn_owned_server(command: &mut Command) -> Result<(Child, OwnedHandle), LaunchError> {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::AssignProcessToJobObject;

    let job = create_server_job()?;
    let mut child = command
        .spawn()
        .map_err(|_| LaunchError("local gallery service could not start"))?;
    let process = HANDLE(child.as_raw_handle());
    // SAFETY: both handles are live and owned by this process. The child is still
    // suspended, so it cannot create an unassigned descendant before this call.
    if unsafe { AssignProcessToJobObject(win32_handle(&job), process) }.is_err() {
        terminate_suspended_child(&mut child);
        return Err(LaunchError(
            "local gallery process could not join its lifecycle job",
        ));
    }
    if let Err(error) = resume_suspended_process(child.id()) {
        drop(job);
        terminate_child(&mut child);
        return Err(error);
    }
    Ok((child, job))
}

#[cfg(windows)]
fn hide_child_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_child_window(_command: &mut Command) {}

#[cfg(windows)]
fn terminate_child(child: &mut Child) {
    if child.try_wait().ok().flatten().is_some() {
        return;
    }
    let mut taskkill = Command::new("taskkill");
    taskkill
        .args(["/PID", &child.id().to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    hide_child_window(&mut taskkill);
    let _ = taskkill.status();
    if child.try_wait().ok().flatten().is_none() {
        let _ = child.kill();
    }
    let _ = child.wait();
}

#[cfg(not(windows))]
fn terminate_child(child: &mut Child) {
    if child.try_wait().ok().flatten().is_some() {
        return;
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn test_session(port: u16) -> BackendSession {
        BackendSession {
            inner: Arc::new(BackendSessionInner {
                url: Url::parse(&format!("http://127.0.0.1:{port}/")).unwrap(),
                session_token: "22".repeat(32),
                instance_secret: [0x11; 32],
                instance_id: [0x33; 16],
                server_path: PathBuf::from("server.py"),
                static_dir: PathBuf::from("static"),
                config_path: PathBuf::from("config.json"),
            }),
        }
    }

    fn valid_identity(session: &BackendSession, challenge: &[u8; 32]) -> ViewerIdentity {
        let pid = 1234;
        let port = session.url().port().unwrap();
        let message = identity_message(challenge, &session.inner.instance_id, port, pid, true);
        ViewerIdentity {
            app: "grok_imagine_viewer".into(),
            protocol_version: DESKTOP_AUTH_PROTOCOL,
            instance_id: encode_hex(&session.inner.instance_id),
            pid,
            port,
            server_path: session.inner.server_path.to_string_lossy().into_owned(),
            static_dir: session.inner.static_dir.to_string_lossy().into_owned(),
            config_path: session.inner.config_path.to_string_lossy().into_owned(),
            download_bind_only: true,
            challenge_response: encode_hex(&hmac_sha256(&session.inner.instance_secret, &message)),
        }
    }

    #[test]
    fn timed_out_child_is_terminated_and_reaped() {
        let mut command = if cfg!(windows) {
            let mut command = Command::new("ping");
            command.args(["-n", "6", "127.0.0.1"]);
            command
        } else {
            let mut command = Command::new("sleep");
            command.arg("5");
            command
        };
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        hide_child_window(&mut command);
        let mut child = command.spawn().expect("slow test child should start");

        assert!(!wait_for_success_or_terminate(
            &mut child,
            Duration::from_millis(50)
        ));
        assert!(child.try_wait().unwrap().is_some());
    }

    #[cfg(windows)]
    #[test]
    fn owned_job_fixture_helper() {
        let Some(pid_path) = env::var_os("GIV_JOB_TEST_PID") else {
            return;
        };
        let mut command = Command::new("ping.exe");
        command
            .args(["-n", "120", "127.0.0.1"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        hide_child_window(&mut command);
        let mut grandchild = command.spawn().expect("fixture grandchild should start");
        fs::write(pid_path, grandchild.id().to_string()).expect("fixture should report pid");
        let _ = grandchild.wait();
    }

    #[cfg(windows)]
    #[test]
    fn closing_server_job_terminates_helper_and_grandchild() {
        use windows::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};
        use windows::Win32::System::Threading::{
            OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
        };

        let temp = env::temp_dir().join(format!(
            "giv-job-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&temp).unwrap();
        let pid_path = temp.join("grandchild.pid");
        let error_path = temp.join("helper-stderr.txt");
        // No shell startup, profile, execution policy or Start-Process behavior:
        // re-enter this test binary, then create an ordinary inherited child.
        let mut command = Command::new(env::current_exe().unwrap());
        command
            .args(["--exact", "backend::tests::owned_job_fixture_helper", "--nocapture"])
            .env("GIV_JOB_TEST_PID", &pid_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::from(fs::File::create(&error_path).unwrap()));
        prepare_owned_server_command(&mut command);
        let (mut child, job) = spawn_owned_server(&mut command).expect("helper should enter job");

        let deadline = Instant::now() + Duration::from_secs(8);
        while !pid_path.is_file() && Instant::now() < deadline {
            if child.try_wait().unwrap().is_some() {
                break;
            }
            thread::sleep(Duration::from_millis(25));
        }
        let report = fs::read_to_string(&pid_path).unwrap_or_else(|error| {
            panic!(
                "fixture did not report pid: {error}; child={:?}; stderr={}",
                child.try_wait(),
                fs::read_to_string(&error_path).unwrap_or_default()
            )
        });
        let grandchild_pid: u32 = report.trim().parse().expect("pid should be numeric");
        // SAFETY: the pid was just returned by our own compiled helper.
        let raw_grandchild = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, grandchild_pid) }
            .expect("grandchild should still be running");
        let grandchild = owned_win32_handle(raw_grandchild);
        assert_eq!(
            unsafe { WaitForSingleObject(win32_handle(&grandchild), 0) },
            WAIT_TIMEOUT,
            "grandchild must be alive before the job closes"
        );

        drop(job);
        assert!(
            wait_for_exit(&mut child, Duration::from_secs(8)),
            "job close should terminate and reap the helper"
        );
        assert_eq!(
            unsafe { WaitForSingleObject(win32_handle(&grandchild), 8_000) },
            WAIT_OBJECT_0,
            "job close should terminate the inherited grandchild"
        );
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn parses_only_exact_loopback_banners() {
        let owned = parse_banner("grok_imagine_viewer  http://127.0.0.1:19706").unwrap();
        assert_eq!(owned.ownership, Ownership::Owned);
        assert_eq!(owned.url.as_str(), "http://127.0.0.1:19706/");

        let shared = parse_banner("already running  http://127.0.0.1:9806").unwrap();
        assert_eq!(shared.ownership, Ownership::Shared);

        assert!(parse_banner("grok_imagine_viewer  https://127.0.0.1:19706").is_none());
        assert!(parse_banner("grok_imagine_viewer  http://localhost:19706").is_none());
        assert!(parse_banner("grok_imagine_viewer  http://127.0.0.1:19706/other").is_none());
        assert!(parse_banner("noise http://127.0.0.1:19706").is_none());
    }

    #[test]
    fn parses_go_sidecar_json_readiness_only_for_exact_loopback() {
        let ready = r#"{"app":"giv-go","origin":"http://127.0.0.1:43127","pid":1234}"#;
        let parsed = parse_banner(ready).expect("Go readiness should be accepted");
        assert_eq!(parsed.ownership, Ownership::Owned);
        assert_eq!(parsed.url.as_str(), "http://127.0.0.1:43127/");

        for invalid in [
            r#"{"app":"giv-go","origin":"http://localhost:43127","pid":1234}"#,
            r#"{"app":"giv-go","origin":"https://127.0.0.1:43127","pid":1234}"#,
            r#"{"app":"other","origin":"http://127.0.0.1:43127","pid":1234}"#,
        ] {
            assert!(parse_banner(invalid).is_none(), "accepted {invalid}");
        }
    }

    #[test]
    fn navigation_is_limited_to_the_bound_origin() {
        let base = Url::parse("http://127.0.0.1:19706/").unwrap();
        assert!(same_origin(
            &base,
            &Url::parse("http://127.0.0.1:19706/api/config").unwrap()
        ));
        assert!(!same_origin(
            &base,
            &Url::parse("http://127.0.0.1:9806/").unwrap()
        ));
        assert!(!same_origin(
            &base,
            &Url::parse("https://127.0.0.1:19706/").unwrap()
        ));
        assert!(!same_origin(
            &base,
            &Url::parse("http://example.test:19706/").unwrap()
        ));
    }

    #[test]
    fn native_gallery_cookie_is_strict_ephemeral_and_port_named() {
        let session = test_session(19_706);
        let cookie = session.gallery_cookie().unwrap();
        assert_eq!(cookie.name(), "GIV_SESSION_19706");
        assert_eq!(cookie.value(), session.inner.session_token);
        assert_eq!(cookie.domain(), Some("127.0.0.1"));
        assert_eq!(cookie.path(), Some("/"));
        assert_eq!(cookie.http_only(), Some(true));
        assert_eq!(format!("{:?}", cookie.same_site()), "Some(Strict)");
        assert!(cookie.max_age().is_none());
        assert!(cookie.expires().is_none());
        assert_ne!(session.url().as_str(), cookie.value());
    }

    #[test]
    fn identity_hmac_matches_the_cross_language_vector() {
        let challenge = [0x44; 32];
        let message = identity_message(&challenge, &[0x33; 16], 19_706, 1234, true);
        assert_eq!(
            encode_hex(&hmac_sha256(&[0x11; 32], &message)),
            "fc2188c93da8e5ef0b9ec26ad50e956b655c4a576b9aaa0e6583c19ffff9800a"
        );
        assert!(decode_lower_hex::<2>("00af").is_some());
        assert!(decode_lower_hex::<2>("00AF").is_none());
    }

    #[test]
    fn identity_requires_every_authenticated_field_to_match() {
        let session = test_session(19_706);
        let challenge = [0x44; 32];
        assert!(identity_is_valid(
            &session,
            &challenge,
            &valid_identity(&session, &challenge)
        ));

        let mut wrong_mac = valid_identity(&session, &challenge);
        wrong_mac.challenge_response = "00".repeat(32);
        assert!(!identity_is_valid(&session, &challenge, &wrong_mac));

        let mut wrong_instance = valid_identity(&session, &challenge);
        wrong_instance.instance_id = "55".repeat(16);
        assert!(!identity_is_valid(&session, &challenge, &wrong_instance));

        let mut wrong_port = valid_identity(&session, &challenge);
        wrong_port.port += 1;
        assert!(!identity_is_valid(&session, &challenge, &wrong_port));

        let mut wrong_protocol = valid_identity(&session, &challenge);
        wrong_protocol.protocol_version += 1;
        assert!(!identity_is_valid(&session, &challenge, &wrong_protocol));
    }

    #[test]
    fn identity_json_rejects_unknown_fields() {
        let json = r#"{
            "app":"grok_imagine_viewer",
            "protocolVersion":3,
            "instanceId":"33333333333333333333333333333333",
            "pid":1234,
            "port":19706,
            "serverPath":"server.py",
            "staticDir":"static",
            "configPath":"config.json",
            "downloadBindOnly":true,
            "challengeResponse":"0000000000000000000000000000000000000000000000000000000000000000",
            "sessionToken":"must-not-be-accepted"
        }"#;
        assert!(serde_json::from_str::<ViewerIdentity>(json).is_err());
    }

    #[test]
    fn raw_config_request_carries_the_session_only_in_a_header() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let session = test_session(port);
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = Vec::new();
            let mut byte = [0_u8; 1];
            while !request.ends_with(b"\r\n\r\n") {
                stream.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
            }
            let body = br#"{"app":"grok_imagine_viewer","staticDir":"static","configPath":"config.json","downloadBindOnly":true}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(response.as_bytes()).unwrap();
            stream.write_all(body).unwrap();
            String::from_utf8(request).unwrap()
        });

        assert!(fetch_config(&session).is_some());
        let request = server.join().unwrap();
        assert!(request.starts_with("GET /api/config?minimal=1 HTTP/1.1\r\n"));
        assert!(request.contains(&format!("Host: 127.0.0.1:{port}\r\n")));
        assert!(request.contains(&format!(
            "X-Viewer-Session: {}\r\n",
            session.inner.session_token
        )));
        assert!(!request
            .lines()
            .next()
            .unwrap_or_default()
            .contains(&session.inner.session_token));
    }

    #[test]
    fn gallery_root_parses_optional_and_empty_values() {
        let with_root: ViewerConfig = serde_json::from_str(
            r#"{"app":"grok_imagine_viewer","staticDir":"static","configPath":"config","root":"/gallery","downloadBindOnly":true}"#,
        )
        .unwrap();
        assert_eq!(
            gallery_root_from_config(with_root).unwrap(),
            Some(PathBuf::from("/gallery"))
        );

        for json in [
            r#"{"app":"grok_imagine_viewer","staticDir":"static","configPath":"config","downloadBindOnly":true}"#,
            r#"{"app":"grok_imagine_viewer","staticDir":"static","configPath":"config","root":null,"downloadBindOnly":true}"#,
            r#"{"app":"grok_imagine_viewer","staticDir":"static","configPath":"config","root":"  ","downloadBindOnly":true}"#,
        ] {
            let config: ViewerConfig = serde_json::from_str(json).unwrap();
            assert_eq!(gallery_root_from_config(config).unwrap(), None);
        }
    }

    #[test]
    fn gallery_root_rejects_another_service_identity() {
        let config: ViewerConfig = serde_json::from_str(
            r#"{"app":"another_app","staticDir":"static","configPath":"config","root":"/gallery","downloadBindOnly":true}"#,
        )
        .unwrap();
        let error = gallery_root_from_config(config).unwrap_err();
        assert_eq!(
            error.to_string(),
            "local gallery service identity check failed"
        );
    }

    #[test]
    fn gallery_root_rejects_service_without_authoritative_bind_mode() {
        let config: ViewerConfig = serde_json::from_str(
            r#"{"app":"grok_imagine_viewer","staticDir":"static","configPath":"config","root":"/gallery"}"#,
        )
        .unwrap();
        assert!(gallery_root_from_config(config).is_err());
    }

    #[test]
    fn strict_http_response_parser_accepts_multiword_reason_phrase() {
        let raw = b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 2\r\n\r\n{}";
        let (status, body) = parse_http_response(raw).unwrap();
        assert_eq!(status, 503);
        assert_eq!(body, b"{}");

        let duplicate = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\n{}";
        assert!(parse_http_response(duplicate).is_none());
    }

    #[test]
    fn download_bind_response_distinguishes_all_safe_outcomes() {
        let expected = Path::new(env!("CARGO_MANIFEST_DIR"));
        let success = serde_json::json!({
            "ok": true,
            "root": expected.to_string_lossy(),
        })
        .to_string();
        match download_bind_from_response(200, success.as_bytes(), expected).unwrap() {
            DownloadBindOutcome::Bound(root) => assert!(same_path(&root, expected)),
            other => panic!("unexpected bind outcome: {other:?}"),
        }

        for (code, expected_outcome) in [
            ("account_mismatch", DownloadBindOutcome::AccountMismatch),
            ("unsupported_mode", DownloadBindOutcome::UnsupportedMode),
            ("library_changed", DownloadBindOutcome::RootChanged),
        ] {
            let body = serde_json::json!({"ok": false, "code": code}).to_string();
            assert_eq!(
                download_bind_from_response(409, body.as_bytes(), expected).unwrap(),
                expected_outcome
            );
        }
    }

    #[test]
    fn download_bind_response_rejects_error_or_another_root() {
        let expected = Path::new(env!("CARGO_MANIFEST_DIR"));
        let failed = br#"{"ok":false,"code":"store_corrupt"}"#;
        assert!(download_bind_from_response(409, failed, expected).is_err());

        let wrong = expected.parent().unwrap();
        let body = serde_json::json!({
            "ok": true,
            "root": wrong.to_string_lossy(),
        })
        .to_string();
        assert!(download_bind_from_response(200, body.as_bytes(), expected).is_err());
    }
}
