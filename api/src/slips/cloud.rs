//! The CLOUD slip reader: Workers AI vision model, metered against the
//! app's own daily neuron cap (see the module doc of [`super`]).
//!
//! Note: `Ai::run` converts its input with serde_wasm_bindgen, which turns a
//! `serde_json::Value` object into a JS `Map` (not a plain object) — so the
//! request is built from plain structs, never `json!`.

use base64::Engine;
use serde::Serialize;
use serde_json::Value;
use worker::Env;

use super::{
    claim_for_cloud, day_key, finish, neurons_for, page_key, reserve_neurons, settle_neurons,
    validate_result, CLOUD_EST_NEURONS_PER_PAGE, CLOUD_MODEL, PROMPT,
};
use crate::media::{self, OpClass};
use crate::util::now_ms;
use crate::{db, error::ApiError};

#[derive(Serialize)]
struct ImageUrl {
    url: String,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Part {
    Text { text: &'static str },
    ImageUrl { image_url: ImageUrl },
}

#[derive(Serialize)]
struct Message {
    role: &'static str,
    content: Vec<Part>,
}

#[derive(Serialize)]
struct ChatTemplateKwargs {
    enable_thinking: bool,
}

#[derive(Serialize)]
struct Input {
    messages: Vec<Message>,
    max_tokens: u32,
    temperature: f32,
    chat_template_kwargs: ChatTemplateKwargs,
}

/// Load page `page` of a slip from R2 (counts one class-B op).
pub async fn load_page(env: &Env, shop_id: &str, slip_id: &str, page: i64) -> Result<Vec<u8>, ApiError> {
    if !media::reserve_op(env, OpClass::B).await? {
        return Err(ApiError::coded(
            axum::http::StatusCode::CONFLICT,
            "media_quota",
            "monthly image read quota reached",
        ));
    }
    let object = db::media(env)?
        .get(page_key(shop_id, slip_id, page))
        .execute()
        .await?
        .ok_or_else(|| ApiError::Internal(format!("slip {slip_id} page {page} missing in R2")))?;
    let body = object
        .body()
        .ok_or_else(|| ApiError::Internal(format!("slip {slip_id} page {page} has no body")))?;
    Ok(body.bytes().await?)
}

/// Reserve budget for `page_count` pages, claim slip `id` for the cloud and
/// read it. Returns false (nothing claimed, nothing spent) when the budget
/// does not allow it or the slip is no longer claimable.
pub async fn read_if_budget(env: &Env, id: &str, page_count: i64) -> Result<bool, ApiError> {
    let day = day_key(now_ms());
    let est = CLOUD_EST_NEURONS_PER_PAGE * page_count.max(1) as f64;
    if !reserve_neurons(env, &day, est).await? {
        return Ok(false);
    }
    let Some(claimed) = claim_for_cloud(env, id).await? else {
        settle_neurons(env, &day, est, 0.0, false).await?;
        return Ok(false);
    };
    let (outcome, used) = match call_model(env, &claimed.shop_id, id, claimed.page_count).await {
        Ok((out, used)) => (validate_output(&out), used),
        Err((e, used)) => (Err(e), used),
    };
    settle_neurons(env, &day, est, used, true).await?;
    if let Err(e) = &outcome {
        worker::console_warn!("slip {id}: cloud read failed: {e}");
    }
    finish(env, id, "cloud", outcome).await?;
    Ok(true)
}

fn validate_output(out: &Value) -> Result<Value, String> {
    let text = out
        .pointer("/choices/0/message/content")
        .or_else(|| out.get("response"))
        .cloned()
        .ok_or("model returned no content")?;
    validate_result(text).map_err(|e| format!("invalid reader output: {e}"))
}

/// Ok((raw output, neurons used)) or Err((message, neurons used)).
async fn call_model(env: &Env, shop_id: &str, id: &str, page_count: i64) -> Result<(Value, f64), (String, f64)> {
    let mut content = vec![Part::Text { text: PROMPT }];
    for page in 1..=page_count {
        let bytes = load_page(env, shop_id, id, page)
            .await
            .map_err(|e| (format!("could not load page {page}: {e:?}"), 0.0))?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
        content.push(Part::ImageUrl {
            image_url: ImageUrl {
                url: format!("data:image/jpeg;base64,{b64}"),
            },
        });
    }
    let input = Input {
        messages: vec![Message {
            role: "user",
            content,
        }],
        max_tokens: 3000,
        temperature: 0.0,
        chat_template_kwargs: ChatTemplateKwargs {
            enable_thinking: false,
        },
    };
    let ai = env.ai("AI").map_err(|e| (format!("AI binding: {e}"), 0.0))?;
    let out: Value = ai
        .run(CLOUD_MODEL, input)
        .await
        .map_err(|e| (format!("Workers AI: {e}"), 0.0))?;
    let usage = |k: &str| out.pointer(&format!("/usage/{k}")).and_then(Value::as_f64).unwrap_or(0.0);
    let used = neurons_for(usage("prompt_tokens"), usage("completion_tokens"));
    Ok((out, used))
}
