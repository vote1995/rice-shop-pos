//! Owner auth: Cloudflare Access sits in front of `owner.<domain>` (email OTP)
//! and forwards a signed JWT in `Cf-Access-Jwt-Assertion`. We verify it
//! against the team's JWKS, then map the verified email to an active
//! `role = 'owner'` row in D1 (the app-level role on top of Access).
//!
//! Error semantics: bad/missing/expired token -> 401, verified but not an
//! owner -> 403, JWKS unreachable -> 503. The last one is undecidable and must
//! never be turned into a 401 (the client would treat it as "logged out").

use std::cell::RefCell;

use axum::{extract::FromRequestParts, http::request::Parts};
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use worker::{send::SendFuture, Date, Env, Fetch, Url};

use super::env_str;
use crate::{db, error::ApiError, AppState};

const JWKS_TTL_MS: u64 = 10 * 60 * 1000;

#[derive(Debug, Clone)]
pub struct OwnerAuth {
    pub user_id: String,
    pub email: String,
}

#[derive(Deserialize)]
struct Jwks {
    keys: Vec<Jwk>,
}

#[derive(Deserialize, Clone)]
struct Jwk {
    kid: String,
    n: Option<String>,
    e: Option<String>,
}

#[derive(Deserialize)]
struct AccessClaims {
    email: Option<String>,
}

struct JwksCache {
    keys: Vec<Jwk>,
    fetched_at: u64,
}

thread_local! {
    // Per-isolate cache; Workers isolates are single-threaded.
    static JWKS_CACHE: RefCell<Option<JwksCache>> = const { RefCell::new(None) };
}

impl FromRequestParts<AppState> for OwnerAuth {
    type Rejection = ApiError;

    fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> impl std::future::Future<Output = Result<Self, Self::Rejection>> + Send {
        let token = parts
            .headers
            .get("cf-access-jwt-assertion")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let env = state.env.clone();
        SendFuture::new(async move { authenticate(&env, token).await })
    }
}

async fn authenticate(env: &Env, token: Option<String>) -> Result<OwnerAuth, ApiError> {
    let aud = env_str(env, "ACCESS_AUD");
    let email = if aud.is_empty() {
        // Local dev only: no Access in front of `wrangler dev`.
        let dev_email = env_str(env, "DEV_OWNER_EMAIL");
        if dev_email.is_empty() {
            return Err(ApiError::Unavailable(
                "owner auth misconfigured: ACCESS_AUD empty and no DEV_OWNER_EMAIL".into(),
            ));
        }
        worker::console_warn!("DEV owner bypass active (ACCESS_AUD empty) as {dev_email}");
        dev_email.to_lowercase()
    } else {
        let team = env_str(env, "ACCESS_TEAM_DOMAIN");
        if team.is_empty() {
            return Err(ApiError::Unavailable("ACCESS_TEAM_DOMAIN not set".into()));
        }
        let token = token.ok_or(ApiError::Unauthorized)?;
        verify_access_jwt(&token, &team, &aud).await?
    };

    #[derive(Deserialize)]
    struct Row {
        id: String,
    }
    let row = db::db(env)?
        .prepare("SELECT id FROM users WHERE email = ?1 AND role = 'owner' AND status = 'active'")
        .bind(&[email.clone().into()])?
        .first::<Row>(None)
        .await?;
    match row {
        Some(Row { id }) => Ok(OwnerAuth { user_id: id, email }),
        None => Err(ApiError::Forbidden),
    }
}

/// Returns the verified, lowercased email claim.
async fn verify_access_jwt(token: &str, team: &str, aud: &str) -> Result<String, ApiError> {
    let kid = decode_header(token)
        .map_err(|_| ApiError::Unauthorized)?
        .kid
        .ok_or(ApiError::Unauthorized)?;

    let jwk = match cached_key(&kid, false) {
        Some(k) => k,
        None => {
            refresh_jwks(team).await?;
            cached_key(&kid, true).ok_or(ApiError::Unauthorized)?
        }
    };
    let (Some(n), Some(e)) = (jwk.n.as_deref(), jwk.e.as_deref()) else {
        return Err(ApiError::Unauthorized);
    };
    let key = DecodingKey::from_rsa_components(n, e).map_err(|_| ApiError::Unauthorized)?;
    validate_claims(token, &key, aud, &format!("https://{team}"))
}

/// Pure JWT check (signature, aud, iss, exp/nbf) -> lowercased email.
fn validate_claims(token: &str, key: &DecodingKey, aud: &str, iss: &str) -> Result<String, ApiError> {
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_audience(&[aud]);
    validation.set_issuer(&[iss]);
    validation.validate_nbf = true;
    validation.leeway = 60;
    let data = decode::<AccessClaims>(token, key, &validation).map_err(|_| ApiError::Unauthorized)?;
    data.claims
        .email
        .filter(|e| !e.is_empty())
        .map(|e| e.to_lowercase())
        .ok_or(ApiError::Unauthorized)
}

/// Looks `kid` up in the cache. Unless `ignore_ttl`, a stale cache counts as a miss.
fn cached_key(kid: &str, ignore_ttl: bool) -> Option<Jwk> {
    let now = Date::now().as_millis();
    JWKS_CACHE.with(|c| {
        let cache = c.borrow();
        let cache = cache.as_ref()?;
        if !ignore_ttl && now.saturating_sub(cache.fetched_at) > JWKS_TTL_MS {
            return None;
        }
        cache.keys.iter().find(|k| k.kid == kid).cloned()
    })
}

async fn refresh_jwks(team: &str) -> Result<(), ApiError> {
    let url = Url::parse(&format!("https://{team}/cdn-cgi/access/certs"))
        .map_err(|e| ApiError::Internal(format!("bad ACCESS_TEAM_DOMAIN: {e}")))?;
    let mut resp = Fetch::Url(url)
        .send()
        .await
        .map_err(|e| ApiError::Unavailable(format!("JWKS fetch failed: {e}")))?;
    if !(200..300).contains(&resp.status_code()) {
        return Err(ApiError::Unavailable(format!("JWKS fetch status {}", resp.status_code())));
    }
    let jwks: Jwks = resp
        .json()
        .await
        .map_err(|e| ApiError::Unavailable(format!("JWKS parse failed: {e}")))?;
    let fetched_at = Date::now().as_millis();
    JWKS_CACHE.with(|c| *c.borrow_mut() = Some(JwksCache { keys: jwks.keys, fetched_at }));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn garbage_token_is_unauthorized_not_panic() {
        // Arbitrary but well-formed RSA public components (n, e = 65537).
        let n = "sXchDaQebHnPiGvyDOAT4saGEUetSyo9MKLOoWFsueri23bOdgWp4Dy1WlUzewbgBHod5pcM9H95GQRV3JDXboIRROSBigeC5yjU1hGzHHyXss8UDprecbAYxknTcQkhslANGRUZmdTOQ5qTRsLAt6BTYuyvVRdhS8exSZEy_c4gs_7svlJJQ4H9_NxsiIoLwAEk7-Q3UXERGYw_75IDrGA84-lA_-Ct4eTlXHBIY2EaV7t7LjJaynVJCpkv4LKjTTAumiGUIuQhrNhZLuF_RJLqHpM2kgWFLU7-VTdL1VbC2tejvcI2BlMkEpk1BzBZI0KQB0GaDWFLN-aEAw3vRw";
        let key = DecodingKey::from_rsa_components(n, "AQAB").unwrap();
        for token in ["", "abc", "a.b.c"] {
            assert!(matches!(
                validate_claims(token, &key, "aud", "https://team.cloudflareaccess.com"),
                Err(ApiError::Unauthorized)
            ));
        }
    }
}
