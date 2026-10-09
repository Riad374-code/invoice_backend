use axum::extract::Request;
use axum::http::HeaderValue;
use axum::middleware::Next;
use axum::response::Response;
use uuid::Uuid;

pub const REQUEST_ID_HEADER: &str = "x-request-id";

#[derive(Clone, Debug)]
pub struct RequestId(pub String);

pub async fn request_id_middleware(mut req: Request, next: Next) -> Response {
    let req_id_str = req
        .headers()
        .get(REQUEST_ID_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("req_{}", Uuid::new_v4().simple()));

    req.extensions_mut().insert(RequestId(req_id_str.clone()));

    let mut res = next.run(req).await;
    if let Ok(val) = HeaderValue::from_str(&req_id_str) {
        res.headers_mut().insert(REQUEST_ID_HEADER, val);
    }
    res
}
