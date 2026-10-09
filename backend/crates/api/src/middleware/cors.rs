use axum::http::{header, Method};
use tower_http::cors::{AllowOrigin, CorsLayer};

pub fn build_cors_layer(allowed_origins: &[String]) -> CorsLayer {
    let origins: Vec<_> = allowed_origins
        .iter()
        .filter_map(|s| s.parse().ok())
        .collect();

    CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            header::ACCEPT,
            header::HeaderName::from_static("x-request-id"),
            header::HeaderName::from_static("x-csrf-token"),
            header::HeaderName::from_static("idempotency-key"),
        ])
        .allow_credentials(true)
}
