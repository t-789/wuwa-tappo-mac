//! Native HTTP bridge for the macOS webview.
//!
//! The WKWebView network process can leave a cross-origin XHR that carries custom
//! headers unsettled forever, which latches the app's one-way request lock (see
//! .work/http-hang-diagnosis.md). The axios adapter in scripts/mac-http.js sends
//! those requests here instead, so the transport never enters the webview's
//! preflight path. Each accepted request is bounded by the same destination,
//! method, header and size allow-lists the WebSocket bridge uses.
use crate::profile::Region;
use futures_util::future::{AbortHandle, Abortable};
use reqwest::{
    header::{HeaderMap, HeaderName, HeaderValue, ORIGIN},
    Method, Url,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{ipc::Channel, Manager, State, WebviewWindow};

/// Same ceiling the WebSocket bridge applies to a single message.
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const MAX_REQUEST_BYTES: usize = 1024 * 1024;
const MAX_REQUESTS: usize = 8;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_TIMEOUT_MS: u64 = 15_000;
/// The server allow-lists this origin; a native stack has none of its own.
const CALLER_ORIGIN: &str = "tauri://localhost";
const ALLOWED_METHODS: &[&str] = &["GET", "POST", "PUT", "DELETE"];
const ALLOWED_HEADERS: &[&str] = &[
    "accept",
    "accept-language",
    "authorization",
    "content-type",
    "istest",
    "lang",
    "pre-release",
    "request-id",
    "x-blm-cid",
    "x-blm-frid",
    "x-blm-uid",
];

#[derive(Clone, Default)]
pub struct HttpState {
    requests: Arc<Mutex<HashMap<(String, String), Pending>>>,
}

struct Pending {
    abort: AbortHandle,
    generation: Arc<()>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequestSpec {
    method: String,
    url: String,
    #[serde(default)]
    headers: Vec<(String, String)>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    timeout_ms: u32,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HttpEvent {
    Head {
        status: u16,
        headers: Vec<(String, String)>,
    },
    Chunk {
        data: String,
    },
    Done {
        bytes: usize,
    },
    Error {
        message: String,
        kind: String,
    },
}

fn validate_destination(region: Region, value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "Invalid HTTP URL")?;
    if url.scheme() != "https"
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("Only the current region's official HTTPS endpoints are allowed".into());
    }
    if url.host_str() == Some(region.api_host()) {
        if !url.path().starts_with("/api/") {
            return Err("Only /api/ paths are allowed on the API host".into());
        }
    } else if url.host_str() != Some(region.asset_host()) {
        return Err("Only the current region's official HTTPS endpoints are allowed".into());
    }
    Ok(url)
}

fn validate_method(value: &str) -> Result<Method, String> {
    let method = value.trim().to_ascii_uppercase();
    if !ALLOWED_METHODS.contains(&method.as_str()) {
        return Err("HTTP method is not allowed".into());
    }
    Method::from_bytes(method.as_bytes()).map_err(|_| "Invalid HTTP method".into())
}

fn request_headers(headers: &[(String, String)]) -> Result<HeaderMap, String> {
    let mut map = HeaderMap::new();
    for (name, value) in headers {
        let name = name.trim().to_ascii_lowercase();
        if !ALLOWED_HEADERS.contains(&name.as_str()) {
            return Err(format!("HTTP header is not allowed: {name}"));
        }
        let header = HeaderName::from_bytes(name.as_bytes()).map_err(|_| "Invalid HTTP header")?;
        let value = HeaderValue::from_str(value.trim()).map_err(|_| "Invalid HTTP header")?;
        map.insert(header, value);
    }
    map.insert(ORIGIN, HeaderValue::from_static(CALLER_ORIGIN));
    Ok(map)
}

fn validate_body(body: Option<String>) -> Result<Option<String>, String> {
    match body {
        Some(text) if text.len() > MAX_REQUEST_BYTES => Err("HTTP request body is too large".into()),
        body => Ok(body),
    }
}

fn timeout_for(requested_ms: u32) -> Duration {
    let requested = u64::from(requested_ms);
    Duration::from_millis(if requested == 0 {
        MAX_TIMEOUT_MS
    } else {
        requested.min(MAX_TIMEOUT_MS)
    })
}

fn validate_caller(label: &str, url: &Url) -> Result<(), String> {
    let local =
        (url.scheme() == "tauri" && url.host_str() == Some("localhost") && url.port().is_none())
            || (matches!(url.scheme(), "http" | "https")
                && url.host_str() == Some("tauri.localhost")
                && url.port().is_none());
    if !matches!(label, "main" | "panel" | "login") || !local {
        return Err("HTTP access requires a trusted app window".into());
    }
    Ok(())
}

fn caller_key(window: &WebviewWindow, id: &str) -> Result<(String, String), String> {
    validate_caller(
        window.label(),
        &window.url().map_err(|_| "Window location is unavailable")?,
    )?;
    if id.is_empty() || id.len() > 96 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("Invalid HTTP request id".into());
    }
    Ok((window.label().into(), id.into()))
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let value = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(TABLE[((value >> 18) & 63) as usize] as char);
        out.push(TABLE[((value >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((value >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(value & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

fn error_kind(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "timeout"
    } else {
        "network"
    }
}

/// Never surfaces the request URL or any header value to the page.
fn safe_error(error: &reqwest::Error, timeout: Duration) -> String {
    if error.is_timeout() {
        format!("timeout of {}ms exceeded", timeout.as_millis())
    } else {
        "Network Error".into()
    }
}

fn fail(events: &Channel<HttpEvent>, message: &str, kind: &str) {
    let _ = events.send(HttpEvent::Error {
        message: message.into(),
        kind: kind.into(),
    });
}

async fn run_request(
    url: Url,
    method: Method,
    headers: HeaderMap,
    body: Option<String>,
    timeout: Duration,
    events: Channel<HttpEvent>,
) {
    let client = match reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(client) => client,
        Err(_) => {
            fail(&events, "HTTP client is unavailable", "network");
            return;
        }
    };
    let mut request = client.request(method, url).headers(headers);
    if let Some(body) = body {
        request = request.body(body);
    }
    let mut response = match request.send().await {
        Ok(response) => response,
        Err(error) => {
            fail(&events, &safe_error(&error, timeout), error_kind(&error));
            return;
        }
    };
    let status = response.status().as_u16();
    let head = response
        .headers()
        .iter()
        .map(|(name, value)| {
            (
                name.as_str().to_ascii_lowercase(),
                value.to_str().unwrap_or_default().to_string(),
            )
        })
        .collect();
    if events.send(HttpEvent::Head { status, headers: head }).is_err() {
        return;
    }
    let mut bytes = 0usize;
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                bytes = bytes.saturating_add(chunk.len());
                if bytes > MAX_RESPONSE_BYTES {
                    fail(&events, "HTTP response is too large", "too_large");
                    return;
                }
                if events
                    .send(HttpEvent::Chunk {
                        data: base64_encode(&chunk),
                    })
                    .is_err()
                {
                    return;
                }
            }
            Ok(None) => break,
            Err(error) => {
                fail(&events, &safe_error(&error, timeout), error_kind(&error));
                return;
            }
        }
    }
    let _ = events.send(HttpEvent::Done { bytes });
}

#[tauri::command]
pub fn native_http_request(
    window: WebviewWindow,
    state: State<'_, HttpState>,
    id: String,
    spec: HttpRequestSpec,
    events: Channel<HttpEvent>,
) -> Result<(), String> {
    let key = caller_key(&window, &id)?;
    let region = Region::from_app(window.app_handle());
    let url = validate_destination(region, &spec.url)?;
    let method = validate_method(&spec.method)?;
    let headers = request_headers(&spec.headers)?;
    let body = validate_body(spec.body)?;
    let timeout = timeout_for(spec.timeout_ms);
    let (abort, registration) = AbortHandle::new_pair();
    let generation = Arc::new(());
    {
        let mut requests = state
            .requests
            .lock()
            .map_err(|_| "HTTP state is unavailable")?;
        if requests.contains_key(&key) {
            return Err("HTTP request id already exists".into());
        }
        if requests.len() >= MAX_REQUESTS {
            return Err("Too many HTTP requests".into());
        }
        requests.insert(
            key.clone(),
            Pending {
                abort,
                generation: generation.clone(),
            },
        );
    }
    let requests = state.requests.clone();
    tauri::async_runtime::spawn(async move {
        let _ = Abortable::new(
            run_request(url, method, headers, body, timeout, events),
            registration,
        )
        .await;
        if let Ok(mut requests) = requests.lock() {
            if requests
                .get(&key)
                .is_some_and(|pending| Arc::ptr_eq(&pending.generation, &generation))
            {
                requests.remove(&key);
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn native_http_abort(
    window: WebviewWindow,
    state: State<'_, HttpState>,
    id: String,
) -> Result<(), String> {
    let key = caller_key(&window, &id)?;
    let mut requests = state
        .requests
        .lock()
        .map_err(|_| "HTTP state is unavailable")?;
    // A request that already settled is not an error: cancelling is best effort.
    if let Some(pending) = requests.remove(&key) {
        pending.abort.abort();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::{io::Write, net::TcpListener};
    use tokio::{
        sync::mpsc::{self, UnboundedReceiver},
        time::timeout as deadline,
    };

    const WAIT: Duration = Duration::from_secs(5);

    fn recorder() -> (Channel<HttpEvent>, UnboundedReceiver<Value>) {
        let (sender, received) = mpsc::unbounded_channel();
        let events = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(value) = body {
                let _ = sender.send(serde_json::from_str(&value).unwrap());
            }
            Ok(())
        });
        (events, received)
    }

    async fn next(received: &mut UnboundedReceiver<Value>) -> Value {
        deadline(WAIT, received.recv())
            .await
            .expect("the bridge stopped emitting events")
            .expect("the bridge closed without an event")
    }

    fn serve(response: String) -> (String, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap().to_string();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0u8; 4096];
            let _ = std::io::Read::read(&mut stream, &mut buffer);
            stream.write_all(response.as_bytes()).unwrap();
            let _ = stream.flush();
        });
        (address, server)
    }

    #[test]
    fn the_adapter_payload_deserializes_into_the_spec() {
        let spec: HttpRequestSpec = serde_json::from_value(serde_json::json!({
            "method": "GET",
            "url": "https://api-mc-wuwatappo.kurogames-global.com/api/common/activity-config",
            "headers": [["x-blm-frid", "synthetic"]],
            "body": null,
            "timeoutMs": 10_000
        }))
        .unwrap();
        assert_eq!(spec.method, "GET");
        assert_eq!(spec.timeout_ms, 10_000);
        assert_eq!(spec.headers, vec![("x-blm-frid".to_string(), "synthetic".to_string())]);
        assert!(spec.body.is_none());
        let minimal: HttpRequestSpec =
            serde_json::from_value(serde_json::json!({"method": "GET", "url": "about:blank"}))
                .unwrap();
        assert!(minimal.headers.is_empty());
        assert_eq!(minimal.timeout_ms, 0);
        assert!(timeout_for(minimal.timeout_ms) > Duration::ZERO);
    }

    #[test]
    fn only_the_regions_official_https_endpoints_are_reachable() {
        let api = |path: &str| format!("https://{}{path}", Region::Cn.api_host());
        assert!(validate_destination(Region::Cn, &api("/api/common/activity-config")).is_ok());
        assert!(validate_destination(Region::Cn, &api("/api/frontend/user/logout")).is_ok());
        assert!(validate_destination(
            Region::Cn,
            &format!("https://{}/assets/pet.png", Region::Cn.asset_host())
        )
        .is_ok());
        for value in [
            api("/api/x").replace("https://", "http://"),
            api("/api").to_string(),
            format!("https://{}:444/api/x", Region::Cn.api_host()),
            format!("https://user:secret@{}/api/x", Region::Cn.api_host()),
            format!("https://{}/api/x#fragment", Region::Cn.api_host()),
            format!("https://{}/socket.io/", Region::Cn.api_host()),
            format!("https://{}api/common/activity-config", Region::Cn.api_host()),
            format!("https://{}.example/api/x", Region::Cn.api_host()),
            format!("https://{}/api/x", Region::Global.api_host()),
            "https://example.com/api/x".to_string(),
        ] {
            assert!(validate_destination(Region::Cn, &value).is_err(), "{value}");
        }
        assert!(validate_destination(
            Region::Global,
            &format!("https://{}/api/x", Region::Global.api_host())
        )
        .is_ok());
    }

    #[test]
    fn only_whitelisted_methods_headers_and_body_sizes_are_forwarded() {
        for method in ["GET", "get", " Post ", "PUT", "DELETE"] {
            assert!(validate_method(method).is_ok(), "{method}");
        }
        for method in ["PATCH", "HEAD", "OPTIONS", "TRACE", "", "GET /api/x HTTP/1.1"] {
            assert!(validate_method(method).is_err(), "{method}");
        }
        let headers = request_headers(&[
            ("Authorization".into(), "Bearer synthetic".into()),
            ("x-blm-frid".into(), "synthetic".into()),
            ("Accept".into(), "application/json".into()),
        ])
        .unwrap();
        assert_eq!(headers[ORIGIN], CALLER_ORIGIN);
        assert_eq!(headers["authorization"], "Bearer synthetic");
        for name in ["cookie", "host", "origin", "x-forwarded-for", ":" ] {
            assert!(
                request_headers(&[(name.into(), "synthetic".into())]).is_err(),
                "{name}"
            );
        }
        assert!(validate_body(Some("x".repeat(MAX_REQUEST_BYTES))).is_ok());
        assert!(validate_body(Some("x".repeat(MAX_REQUEST_BYTES + 1))).is_err());
        assert!(validate_body(None).unwrap().is_none());
    }

    #[test]
    fn the_total_timeout_can_only_be_lowered_and_never_exceeds_the_ceiling() {
        assert_eq!(timeout_for(0), Duration::from_millis(MAX_TIMEOUT_MS));
        assert_eq!(timeout_for(10_000), Duration::from_millis(10_000));
        assert_eq!(timeout_for(60_000), Duration::from_millis(MAX_TIMEOUT_MS));
    }

    #[test]
    fn the_bridge_only_answers_trusted_windows() {
        for label in ["main", "panel", "login"] {
            assert!(validate_caller(label, &Url::parse("tauri://localhost/index.html").unwrap())
                .is_ok());
        }
        for (label, url) in [
            ("bootstrap", "tauri://localhost"),
            ("main", "https://example.com"),
            ("main", "http://tauri.localhost:43127"),
            ("main", "tauri://foreign"),
        ] {
            assert!(validate_caller(label, &Url::parse(url).unwrap()).is_err());
        }
    }

    #[test]
    fn base64_matches_the_rfc_4648_vectors() {
        for (input, encoded) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(base64_encode(input.as_bytes()), encoded, "{input}");
        }
    }

    #[tokio::test]
    async fn a_local_server_response_keeps_its_status_and_lowercases_every_header() {
        let body = "{\"code\":0,\"message\":\"Success\"}";
        let response = format!(
            "HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nX-Request-Id: synthetic\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let (address, server) = serve(response);
        let (events, mut received) = recorder();
        run_request(
            Url::parse(&format!("http://{address}/api/common/activity-config?")).unwrap(),
            Method::GET,
            request_headers(&[("accept".into(), "application/json".into())]).unwrap(),
            None,
            Duration::from_secs(5),
            events,
        )
        .await;
        server.join().unwrap();
        let head = next(&mut received).await;
        assert_eq!(head["type"], "head");
        assert_eq!(head["status"], 404);
        let pairs = head["headers"].as_array().unwrap();
        let names: Vec<&str> = pairs.iter().map(|pair| pair[0].as_str().unwrap()).collect();
        assert!(names.iter().all(|name| name.chars().all(|c| !c.is_ascii_uppercase())));
        let lookup = |name: &str| {
            pairs
                .iter()
                .find(|pair| pair[0] == name)
                .map(|pair| pair[1].as_str().unwrap().to_string())
        };
        assert_eq!(lookup("x-request-id").as_deref(), Some("synthetic"));
        assert_eq!(lookup("content-type").as_deref(), Some("application/json"));
        let chunk = next(&mut received).await;
        assert_eq!(chunk["type"], "chunk");
        assert_eq!(chunk["data"], base64_encode(body.as_bytes()));
        let done = next(&mut received).await;
        assert_eq!(done["type"], "done");
        assert_eq!(done["bytes"], body.len());
        assert!(deadline(WAIT, received.recv()).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn a_stalled_server_reports_a_timeout_instead_of_a_network_error() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap().to_string();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0u8; 4096];
            let _ = std::io::Read::read(&mut stream, &mut buffer);
            std::thread::sleep(Duration::from_secs(2));
        });
        let (events, mut received) = recorder();
        run_request(
            Url::parse(&format!("http://{address}/api/common/activity-config")).unwrap(),
            Method::GET,
            HeaderMap::new(),
            None,
            Duration::from_millis(200),
            events,
        )
        .await;
        let event = next(&mut received).await;
        assert_eq!(event["type"], "error");
        assert_eq!(event["kind"], "timeout");
        assert_eq!(event["message"], "timeout of 200ms exceeded");
        server.join().unwrap();
    }
}
