//! Thin helpers around the Workers bindings declared in `wrangler.toml`.
//!
//! Bindings (schema v1 / M0):
//! - `DB`   → D1 database `rice-pos` (all POS data, see `migrations/`)
//! - `MEDIA`→ R2 bucket `rice-pos-media` (menu images, later: backups/archives)

use crate::error::ApiError;
use worker::{Bucket, D1Database, Env};

pub const DB_BINDING: &str = "DB";
#[allow(dead_code)] // used by the R2 (media) tickets
pub const R2_BINDING: &str = "MEDIA";

pub fn db(env: &Env) -> Result<D1Database, ApiError> {
    env.d1(DB_BINDING)
        .map_err(|e| ApiError::Internal(format!("D1 binding '{DB_BINDING}' unavailable: {e}")))
}

#[allow(dead_code)] // used by the R2 (media) tickets
pub fn media(env: &Env) -> Result<Bucket, ApiError> {
    env.bucket(R2_BINDING).map_err(|e| {
        ApiError::Internal(format!("R2 binding '{R2_BINDING}' unavailable: {e}"))
    })
}
