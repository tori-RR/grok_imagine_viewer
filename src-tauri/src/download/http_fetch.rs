//! Credential-free, bounded HTTP transport. Authenticated requests stay in the
//! Grok WebView; this module never extracts its cookies or starts a PATH sidecar.
use super::{is_asset_key, is_supported_media_mime, Asset, MAX_MEDIA_BYTES};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
use url::Url;

pub(super) const HTTP_WORKERS: usize = 3;
const PROBE_BYTES: usize = 1024;
const REDIRECT_LIMIT: usize = 3;
const TRANSFER_LIMIT: Duration = Duration::from_secs(120);

/// Clones share ureq's connection pool, but not a browser session/cookie store.
#[derive(Clone)]
pub(super) struct HttpBackend {
    agent: ureq::Agent,
}

impl HttpBackend {
    pub(super) fn label(&self) -> &'static str { "native-public" }
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum HttpFetchError {
    Input,
    Auth(u16),
    Status(u16),
    Network,
    Size,
    Mime,
    Redirect,
    Cancelled,
    Io,
}

impl HttpFetchError {
    fn from_status(status: u16) -> Self {
        if matches!(status, 401 | 403) { Self::Auth(status) } else { Self::Status(status) }
    }

    /// Finite vocabulary/numeric evidence only; never an HTTP body or URL.
    pub(super) fn status_line(&self) -> String {
        match self {
            Self::Auth(status) | Self::Status(status) => format!("http_fallback status {status}"),
            other => format!("http_fallback {:?}", other).to_ascii_lowercase(),
        }
    }

    pub(super) fn stops_queue(&self) -> bool {
        matches!(self, Self::Auth(_) | Self::Status(429))
    }
}

#[derive(Debug, Clone)]
pub(super) struct HttpProbe {
    pub(super) host: String,
    pub(super) status: u16,
    pub(super) accept_ranges: bool,
    pub(super) bytes: u64,
}

impl HttpProbe {
    pub(super) fn detached_ok(&self) -> bool {
        matches!(self.status, 200 | 206) && self.bytes > 0
    }
    pub(super) fn status_line(&self) -> String {
        format!("probe {} {} {}B omit{}", self.host, self.status, self.bytes,
                if self.accept_ranges { " ranges" } else { "" })
    }
}

pub(super) fn media_url(key: &str) -> Result<Url, HttpFetchError> {
    if !is_asset_key(key) { return Err(HttpFetchError::Input); }
    let mut url = Url::parse("https://assets.grok.com/").map_err(|_| HttpFetchError::Input)?;
    url.set_path(&format!("/{key}"));
    url.query_pairs_mut().append_pair("cache", "1");
    Ok(url)
}

pub(super) fn host_allowed(url: &Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && url.fragment().is_none()
        && matches!(url.host_str(), Some("assets.grok.com") | Some("imagine-public.x.ai"))
}

pub(super) fn preferred_detached() -> HttpBackend {
    // Installing aria2 on PATH must not silently replace the validated transport.
    // The old adapter could not constrain redirect destinations or streaming size.
    HttpBackend { agent: ureq::AgentBuilder::new()
        .redirects(0)
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(10))
        .timeout_write(Duration::from_secs(10))
        .build() }
}

fn same_media_family(expected: &str, content_type: &str) -> bool {
    let mime = content_type.split(';').next().unwrap_or_default().trim().to_ascii_lowercase();
    // Some CDN responses omit MIME; commit still requires a matching file signature.
    mime.is_empty() || mime == "application/octet-stream"
        || (expected.starts_with("image/") && mime.starts_with("image/"))
        || (expected.starts_with("video/") && mime.starts_with("video/"))
}

fn follow_location(current: &Url, location: &str) -> Result<Url, HttpFetchError> {
    let next = current.join(location).map_err(|_| HttpFetchError::Redirect)?;
    if host_allowed(&next) { Ok(next) } else { Err(HttpFetchError::Redirect) }
}

fn redirect_target(response: &ureq::Response, current: &Url) -> Result<Option<Url>, HttpFetchError> {
    if matches!(response.status(), 301 | 302 | 303 | 307 | 308) {
        let location = response.header("location").ok_or(HttpFetchError::Redirect)?;
        return follow_location(current, location).map(Some);
    }
    Ok(None)
}

fn request_response(
    backend: &HttpBackend, start: &Url, mime: &str, probe: bool,
    cancel: &dyn Fn() -> bool,
) -> Result<(ureq::Response, Url), HttpFetchError> {
    let started = Instant::now();
    let mut url = start.clone();
    for hop in 0..=REDIRECT_LIMIT {
        if cancel() { return Err(HttpFetchError::Cancelled); }
        if started.elapsed() >= TRANSFER_LIMIT { return Err(HttpFetchError::Network); }
        if !host_allowed(&url) { return Err(HttpFetchError::Redirect); }
        let mut request = backend.agent.get(url.as_str()).set("Accept", "*/*").set("Accept-Encoding", "identity");
        if probe { request = request.set("Range", "bytes=0-1023"); }
        // ureq 2.x returns 3xx as Ok(Response) when redirects are disabled.
        let response = match request.call() {
            Ok(response) | Err(ureq::Error::Status(_, response)) => response,
            Err(_) => return Err(HttpFetchError::Network),
        };
        if let Some(next) = redirect_target(&response, &url)? {
            if hop == REDIRECT_LIMIT { return Err(HttpFetchError::Redirect); }
            url = next;
            continue;
        }
        let status = response.status();
        if status != 200 && !(probe && status == 206) {
            return Err(HttpFetchError::from_status(status));
        }
        if !same_media_family(mime, response.header("content-type").unwrap_or_default()) {
            return Err(HttpFetchError::Mime);
        }
        return Ok((response, url));
    }
    Err(HttpFetchError::Redirect)
}

fn response_length(response: &ureq::Response) -> Result<Option<u64>, HttpFetchError> {
    response.header("content-length").map(|raw| {
        let n = raw.parse::<u64>().map_err(|_| HttpFetchError::Size)?;
        if n == 0 || n > MAX_MEDIA_BYTES { Err(HttpFetchError::Size) } else { Ok(n) }
    }).transpose()
}

fn probe_length(response: &ureq::Response) -> Result<usize, HttpFetchError> {
    let length = response_length(response)?;
    if response.status() != 206 {
        return Ok(length.unwrap_or(PROBE_BYTES as u64).min(PROBE_BYTES as u64) as usize);
    }
    let value = response.header("content-range").and_then(|s| s.strip_prefix("bytes "))
        .ok_or(HttpFetchError::Size)?;
    let (interval, total) = value.split_once('/').ok_or(HttpFetchError::Size)?;
    let (start, end) = interval.split_once('-').ok_or(HttpFetchError::Size)?;
    let start = start.parse::<u64>().map_err(|_| HttpFetchError::Size)?;
    let end = end.parse::<u64>().map_err(|_| HttpFetchError::Size)?;
    let total = total.parse::<u64>().map_err(|_| HttpFetchError::Size)?;
    if start != 0 || end >= PROBE_BYTES as u64 || end >= total || total > MAX_MEDIA_BYTES
        || length.is_some_and(|n| n != end + 1) {
        return Err(HttpFetchError::Size);
    }
    Ok((end + 1) as usize)
}

pub(super) fn probe_asset(
    backend: &HttpBackend, key: &str, mime: &str, cancel: &AtomicBool,
) -> Result<HttpProbe, HttpFetchError> {
    if !is_supported_media_mime(mime) { return Err(HttpFetchError::Mime); }
    let (response, final_url) = request_response(backend, &media_url(key)?, mime, true,
        &|| cancel.load(Ordering::Acquire))?;
    let status = response.status();
    let bytes = probe_length(&response)?;
    let accept_ranges = status == 206 || response.header("accept-ranges").is_some_and(|s| s.eq_ignore_ascii_case("bytes"));
    let mut reader = response.into_reader();
    let mut buf = [0_u8; PROBE_BYTES];
    if cancel.load(Ordering::Acquire) { return Err(HttpFetchError::Cancelled); }
    reader.read_exact(&mut buf[..bytes]).map_err(|_| HttpFetchError::Network)?;
    if cancel.load(Ordering::Acquire) { return Err(HttpFetchError::Cancelled); }
    Ok(HttpProbe { host: final_url.host_str().unwrap_or_default().to_owned(), status,
        accept_ranges, bytes: bytes as u64 })
}

fn write_body(
    mut reader: impl Read, dest: &Path, expected: Option<u64>,
    cancel: &dyn Fn() -> bool,
) -> Result<u64, HttpFetchError> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(dest)
        .map_err(|_| HttpFetchError::Io)?;
    let result = (|| {
        let started = Instant::now();
        let mut buf = [0_u8; 65_536];
        let mut total = 0_u64;
        loop {
            if cancel() { return Err(HttpFetchError::Cancelled); }
            if started.elapsed() >= TRANSFER_LIMIT { return Err(HttpFetchError::Network); }
            let read = reader.read(&mut buf).map_err(|_| HttpFetchError::Network)?;
            if read == 0 { break; }
            total = total.checked_add(read as u64).ok_or(HttpFetchError::Size)?;
            if total > MAX_MEDIA_BYTES || expected.is_some_and(|n| total > n) {
                return Err(HttpFetchError::Size);
            }
            file.write_all(&buf[..read]).map_err(|_| HttpFetchError::Io)?;
        }
        if cancel() { return Err(HttpFetchError::Cancelled); }
        if total == 0 || expected.is_some_and(|n| n != total) { return Err(HttpFetchError::Size); }
        file.sync_all().map_err(|_| HttpFetchError::Io)?;
        Ok(total)
    })();
    drop(file);
    // create_new succeeded: this call owns exactly this partial, never a prior file.
    if result.is_err() { let _ = fs::remove_file(dest); }
    result
}

pub(super) fn fetch_asset(
    backend: &HttpBackend, asset: &Asset, dest: &Path, cancel: &dyn Fn() -> bool,
) -> Result<u64, HttpFetchError> {
    let declared = asset.sz.filter(|n| *n > 0);
    if declared.is_some_and(|n| n > MAX_MEDIA_BYTES) { return Err(HttpFetchError::Size); }
    if !is_supported_media_mime(&asset.mime) { return Err(HttpFetchError::Mime); }
    let (response, _) = request_response(backend, &media_url(&asset.key)?, &asset.mime, false, cancel)?;
    let length = response_length(&response)?;
    if declared.zip(length).is_some_and(|(a, b)| a != b) { return Err(HttpFetchError::Size); }
    write_body(response.into_reader(), dest, declared.or(length), cancel)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{self, Cursor};
    fn root() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("giv-http-test-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir(&root).unwrap(); root
    }
    #[test]
    fn media_url_stays_on_the_allowlisted_host() {
        let url = media_url("generated/abc/file.jpg").unwrap();
        assert_eq!(url.host_str(), Some("assets.grok.com"));
        assert_eq!(url.query(), Some("cache=1"));
        assert!(media_url("../escape").is_err());
    }
    #[test]
    fn redirect_target_is_validated_even_for_a_successful_ureq_response() {
        let start = media_url("abc/file.jpg").unwrap();
        let r: ureq::Response = "HTTP/1.1 302 Found\r\nLocation: https://imagine-public.x.ai/a\r\n\r\n".parse().unwrap();
        assert_eq!(redirect_target(&r, &start).unwrap().unwrap().host_str(), Some("imagine-public.x.ai"));
        for target in ["http://assets.grok.com/a", "https://assets.grok.com:444/a", "https://evil.example/a", "https://u:p@assets.grok.com/a", "https://assets.grok.com/a#x"] {
            assert!(!host_allowed(&Url::parse(target).unwrap()));
            assert!(follow_location(&start, target).is_err());
        }
    }
    #[test]
    fn partial_probe_requires_a_consistent_range() {
        for raw in ["bytes 1-10/20", "bytes 0-1024/2048", "bytes 0-3/*", "bytes 0-9/9"] {
            let r: ureq::Response = format!("HTTP/1.1 206 Partial Content\r\nContent-Range: {raw}\r\n\r\n").parse().unwrap();
            assert!(probe_length(&r).is_err());
        }
        let r: ureq::Response = "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-3/4\r\nContent-Length: 4\r\n\r\nxxxx".parse().unwrap();
        assert_eq!(probe_length(&r).unwrap(), 4);
    }
    #[test]
    fn transport_error_and_cancellation_remove_only_owned_partials() {
        struct Broken(bool);
        impl Read for Broken {
            fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
                if self.0 { return Err(io::Error::new(io::ErrorKind::ConnectionReset, "fixture")); }
                self.0 = true; buf[0] = 1; Ok(1)
            }
        }
        let root = root(); let dest = root.join("part");
        assert_eq!(write_body(Broken(false), &dest, None, &||false), Err(HttpFetchError::Network));
        assert!(!dest.exists());
        assert_eq!(write_body(Cursor::new(b"abc"), &dest, None, &||true), Err(HttpFetchError::Cancelled));
        assert!(!dest.exists());
        fs::write(&dest, b"keep").unwrap();
        assert_eq!(write_body(Cursor::new(b"abc"), &dest, None, &||false), Err(HttpFetchError::Io));
        assert_eq!(fs::read(&dest).unwrap(), b"keep");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn body_length_is_enforced_and_success_is_kept() {
        let root = root(); let dest = root.join("part");
        assert_eq!(write_body(Cursor::new(b"abc"), &dest, Some(4), &||false), Err(HttpFetchError::Size));
        assert!(!dest.exists());
        assert_eq!(write_body(Cursor::new(b"abc"), &dest, Some(3), &||false).unwrap(), 3);
        assert_eq!(fs::read(&dest).unwrap(), b"abc"); fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn auth_and_rate_limit_stop_public_queue_without_disclosing_payloads() {
        assert!(HttpFetchError::Auth(403).stops_queue());
        assert!(HttpFetchError::Status(429).stops_queue());
        assert!(!HttpFetchError::Status(404).stops_queue());
        assert_eq!(HttpFetchError::Status(429).status_line(), "http_fallback status 429");
    }
}
