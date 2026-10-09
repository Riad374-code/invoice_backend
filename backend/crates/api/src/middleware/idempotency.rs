use axum::extract::FromRequestParts;
use axum::http::request::Parts;

pub const IDEMPOTENCY_KEY_HEADER: &str = "idempotency-key";

#[derive(Clone, Debug)]
pub struct IdempotencyKey(pub Option<String>);

#[axum::async_trait]
impl<S> FromRequestParts<S> for IdempotencyKey
where
    S: Send + Sync,
{
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        let key = parts
            .headers
            .get(IDEMPOTENCY_KEY_HEADER)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        Ok(IdempotencyKey(key))
    }
}
