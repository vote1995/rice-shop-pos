//! Authentication. Owner (Cloudflare Access) and staff (device + PIN) auth are
//! kept in separate modules on purpose: they are different populations behind
//! different mechanisms and must be able to evolve independently.

pub mod crypto;
pub mod owner;

use worker::Env;

/// Reads a plain var or a secret (`.dev.vars` / `wrangler secret put`);
/// missing -> empty string.
pub(crate) fn env_str(env: &Env, name: &str) -> String {
    env.var(name)
        .or_else(|_| env.secret(name))
        .map(|v| v.to_string())
        .unwrap_or_default()
}
