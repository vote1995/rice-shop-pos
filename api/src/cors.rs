//! Opt-in, allowlist-based CORS — lets the Capacitor Android staff POS
//! (WebView origin `https://localhost`) call the staff API cross-origin.
//!
//! Rules:
//! - **Off by default.** `CORS_ALLOWED_ORIGINS` unset/empty => the Worker
//!   behaves exactly as before: no CORS headers anywhere, OPTIONS untouched.
//! - **Exact-match allowlist.** The response echoes the request's own `Origin`
//!   only when it is listed verbatim. Never `*`, never an arbitrary origin,
//!   never `Access-Control-Allow-Credentials` (auth is header-based —
//!   `X-Device-Token` / `Authorization: Bearer` — there are no cookies).
//! - **Scoped to `/api/*` except `/api/owner/*`** (owner routes sit behind
//!   Cloudflare Access cookies and must stay same-origin) **and
//!   `/api/beam/webhook`** (server-to-server). Excluded paths never get CORS
//!   headers and never get a preflight answer.
//!
//! The fetch entrypoint in `lib.rs` reads the allowlist, calls the pure
//! [`decide`] on `(origin, path, allowlist)` (+ the two facts that mark a real
//! preflight) and then either answers the preflight itself or tags the actual
//! response. Same-origin requests are untouched: with no `Origin` header, or
//! with an unlisted one, the request is passed through verbatim.

use axum::body::Body;
use axum::http::{header, HeaderMap, HeaderValue, Method, Response, StatusCode};

/// Plain var read with `Env::var` (wrangler.toml `[vars]` / `.dev.vars`):
/// comma-separated exact origins, e.g. `"https://localhost"`.
pub const ENV_VAR: &str = "CORS_ALLOWED_ORIGINS";

/// Everything the staff POS sends. Auth is header-based, so no cookie header.
const ALLOW_HEADERS: &str = "Content-Type, Authorization, X-Device-Token";
/// Every method the in-scope API uses.
const ALLOW_METHODS: &str = "GET, POST, PUT, DELETE, OPTIONS";
/// One day: the WebView outlives that easily, so preflights are not re-sent.
const MAX_AGE: &str = "86400";
/// The only in-scope response header that is not CORS-safelisted: `/api/media/*`
/// sends `ETag` and the client revalidates with `If-None-Match`
/// (api/src/routes/media.rs). `Cache-Control` etc. are safelisted already.
const EXPOSE_HEADERS: &str = "ETag";

/// Parse the env var: comma-separated origins, each trimmed, empties dropped.
pub fn parse_allowlist(raw: Option<&str>) -> Vec<String> {
    match raw {
        Some(v) => v
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect(),
        None => Vec::new(),
    }
}

/// May this request path be served cross-origin? `/api/*` minus the owner
/// console (`/api/owner/*`, Cloudflare Access cookies) and the Beam webhook.
pub fn path_in_scope(path: &str) -> bool {
    match path.strip_prefix("/api/") {
        Some(rest) => !(rest == "beam/webhook" || rest == "owner" || rest.starts_with("owner/")),
        None => false,
    }
}

/// What the fetch entrypoint should do with a request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// Run the router exactly as before: no CORS headers, preflights included.
    /// (Allowlist empty, no `Origin`, unlisted origin, or excluded path.)
    Passthrough,
    /// Allowed origin + in-scope preflight: answer 204 directly
    /// ([`preflight_response`]) — the router never sees the request.
    Preflight,
    /// Allowed origin + in-scope path: run the handler, then add CORS headers
    /// to the response, whatever its status (errors included: a 401 the WebView
    /// can read beats an opaque network error).
    Allow,
}

/// Pure decision from `(origin, path, allowlist)` plus the two request facts
/// that make a preflight (`OPTIONS` + `Access-Control-Request-Method`).
pub fn decide(
    origin: Option<&str>,
    method: &Method,
    has_request_method: bool,
    path: &str,
    allowlist: &[String],
) -> Decision {
    if allowlist.is_empty() {
        return Decision::Passthrough; // CORS fully disabled
    }
    // Exact string match only — no substring, no suffix, no scheme fuzz.
    let allowed = origin.is_some_and(|o| allowlist.iter().any(|a| a == o));
    if !allowed || !path_in_scope(path) {
        return Decision::Passthrough;
    }
    if *method == Method::OPTIONS && has_request_method {
        Decision::Preflight
    } else {
        Decision::Allow
    }
}

/// The 204 answer for an allowed preflight (`origin` already validated by
/// [`decide`], so echoing it back is by construction an allowed value).
pub fn preflight_response(origin: &str) -> Response<Body> {
    let mut res = Response::new(Body::empty());
    *res.status_mut() = StatusCode::NO_CONTENT;
    let h = res.headers_mut();
    // `from_str` cannot fail in practice (the value arrived as a header), but
    // if it ever did we simply send no ACAO — fail closed, the browser blocks.
    if let Ok(v) = HeaderValue::from_str(origin) {
        h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, v);
    }
    h.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static(ALLOW_METHODS),
    );
    h.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static(ALLOW_HEADERS),
    );
    h.insert(header::ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static(MAX_AGE));
    h.insert(header::VARY, HeaderValue::from_static("Origin"));
    res
}

/// CORS headers for an actual (non-preflight) response from an in-scope path.
/// `Vary` is appended (not replaced) in case a handler set its own.
pub fn add_response_headers(headers: &mut HeaderMap, origin: &str) {
    if let Ok(v) = HeaderValue::from_str(origin) {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, v);
        headers.append(header::VARY, HeaderValue::from_static("Origin"));
        headers.insert(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            HeaderValue::from_static(EXPOSE_HEADERS),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowlist(entries: &[&str]) -> Vec<String> {
        entries.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn allowlist_parsing_trims_and_drops_empties() {
        assert!(parse_allowlist(None).is_empty());
        assert!(parse_allowlist(Some("")).is_empty());
        assert!(parse_allowlist(Some("   ")).is_empty());
        assert!(parse_allowlist(Some(" , ,")).is_empty());
        assert_eq!(
            parse_allowlist(Some(" https://localhost ,https://pos.example, ")),
            ["https://localhost", "https://pos.example"]
        );
    }

    #[test]
    fn disabled_when_allowlist_unset_or_empty() {
        for raw in [None, Some(""), Some("   "), Some(",")] {
            let list = parse_allowlist(raw);
            assert_eq!(
                decide(
                    Some("https://localhost"),
                    &Method::GET,
                    false,
                    "/api/menu",
                    &list
                ),
                Decision::Passthrough,
                "raw={raw:?}"
            );
            // OPTIONS is left entirely to the router (today's behaviour).
            assert_eq!(
                decide(
                    Some("https://localhost"),
                    &Method::OPTIONS,
                    true,
                    "/api/menu",
                    &list
                ),
                Decision::Passthrough,
                "raw={raw:?}"
            );
        }
    }

    #[test]
    fn allowed_origin_on_in_scope_path() {
        let list = allowlist(&["https://localhost"]);
        assert_eq!(
            decide(
                Some("https://localhost"),
                &Method::GET,
                false,
                "/api/menu",
                &list
            ),
            Decision::Allow
        );
        assert_eq!(
            decide(
                Some("https://localhost"),
                &Method::POST,
                false,
                "/api/orders",
                &list
            ),
            Decision::Allow
        );
        // Second listed origin works too.
        let two = allowlist(&["https://localhost", "capacitor://localhost"]);
        assert_eq!(
            decide(
                Some("capacitor://localhost"),
                &Method::GET,
                false,
                "/api/health",
                &two
            ),
            Decision::Allow
        );
    }

    #[test]
    fn disallowed_or_missing_origin_passes_through() {
        let list = allowlist(&["https://localhost"]);
        for origin in [
            "https://evil.example",
            "https://localhost.evil.example", // suffix trick
            "http://localhost",              // scheme matters: exact match
            "https://localhost/",
        ] {
            assert_eq!(
                decide(Some(origin), &Method::GET, false, "/api/menu", &list),
                Decision::Passthrough,
                "origin={origin}"
            );
        }
        // No Origin header at all (same-origin / curl): never treated as CORS.
        assert_eq!(
            decide(None, &Method::GET, false, "/api/menu", &list),
            Decision::Passthrough
        );
    }

    #[test]
    fn owner_paths_are_never_in_scope() {
        let list = allowlist(&["https://localhost"]);
        for path in [
            "/api/owner/me",
            "/api/owner/shops/1/orders",
            "/api/owner/slips/2/pages/0",
            "/api/owner",
        ] {
            assert_eq!(
                decide(Some("https://localhost"), &Method::GET, false, path, &list),
                Decision::Passthrough,
                "GET {path}"
            );
            // Preflights are not answered either (Access cookies must stay
            // same-origin; the router's 405 carries no CORS headers).
            assert_eq!(
                decide(Some("https://localhost"), &Method::OPTIONS, true, path, &list),
                Decision::Passthrough,
                "OPTIONS {path}"
            );
        }
    }

    #[test]
    fn beam_webhook_is_never_in_scope() {
        let list = allowlist(&["https://localhost"]);
        assert_eq!(
            decide(
                Some("https://localhost"),
                &Method::POST,
                false,
                "/api/beam/webhook",
                &list
            ),
            Decision::Passthrough
        );
        assert_eq!(
            decide(
                Some("https://localhost"),
                &Method::OPTIONS,
                true,
                "/api/beam/webhook",
                &list
            ),
            Decision::Passthrough
        );
        // Paths outside /api/ (SPA assets) are out of scope as well.
        assert_eq!(
            decide(
                Some("https://localhost"),
                &Method::GET,
                false,
                "/owner",
                &list
            ),
            Decision::Passthrough
        );
    }

    #[test]
    fn preflight_only_for_allowed_in_scope_options() {
        let list = allowlist(&["https://localhost"]);
        assert_eq!(
            decide(
                Some("https://localhost"),
                &Method::OPTIONS,
                true,
                "/api/orders",
                &list
            ),
            Decision::Preflight
        );
        // OPTIONS without Access-Control-Request-Method is not a preflight:
        // normal handling (router's 405) with response headers added.
        assert_eq!(
            decide(
                Some("https://localhost"),
                &Method::OPTIONS,
                false,
                "/api/orders",
                &list
            ),
            Decision::Allow
        );
        // A preflight from a disallowed origin is NOT answered with CORS.
        assert_eq!(
            decide(
                Some("https://evil.example"),
                &Method::OPTIONS,
                true,
                "/api/orders",
                &list
            ),
            Decision::Passthrough
        );
    }

    #[test]
    fn preflight_response_shape() {
        let res = preflight_response("https://localhost");
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        let h = res.headers();
        assert_eq!(
            h.get(header::ACCESS_CONTROL_ALLOW_ORIGIN).unwrap(),
            "https://localhost"
        );
        assert_eq!(
            h.get(header::ACCESS_CONTROL_ALLOW_METHODS).unwrap(),
            "GET, POST, PUT, DELETE, OPTIONS"
        );
        assert_eq!(
            h.get(header::ACCESS_CONTROL_ALLOW_HEADERS).unwrap(),
            "Content-Type, Authorization, X-Device-Token"
        );
        assert_eq!(h.get(header::ACCESS_CONTROL_MAX_AGE).unwrap(), "86400");
        assert_eq!(h.get(header::VARY).unwrap(), "Origin");
        // Credential-less by design; never a wildcard.
        assert!(h.get(header::ACCESS_CONTROL_ALLOW_CREDENTIALS).is_none());
        assert_ne!(
            h.get(header::ACCESS_CONTROL_ALLOW_ORIGIN).unwrap(),
            HeaderValue::from_static("*")
        );
    }

    #[test]
    fn actual_response_headers_shape() {
        let mut h = HeaderMap::new();
        add_response_headers(&mut h, "https://localhost");
        assert_eq!(
            h.get(header::ACCESS_CONTROL_ALLOW_ORIGIN).unwrap(),
            "https://localhost"
        );
        assert_eq!(h.get(header::VARY).unwrap(), "Origin");
        assert_eq!(h.get(header::ACCESS_CONTROL_EXPOSE_HEADERS).unwrap(), "ETag");
        assert!(h.get(header::ACCESS_CONTROL_ALLOW_CREDENTIALS).is_none());
        // Vary is appended, not clobbered.
        add_response_headers(&mut h, "https://localhost");
        assert_eq!(h.get_all(header::VARY).iter().count(), 2);
    }
}
