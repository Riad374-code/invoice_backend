use axum::extract::State;
use axum::Json;
use chrono::Utc;
use serde::Serialize;

use crate::error::ApiError;
use crate::middleware::auth::RequireAuth;
use crate::state::AppState;
use lexaudit_domain::permissions;

#[derive(Debug, Serialize)]
pub struct HealthResponse {
    pub status: String,
    pub service: String,
    pub version: String,
    pub timestamp: String,
}

pub async fn health_handler() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok".to_string(),
        service: "lexaudit-api".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        timestamp: Utc::now().to_rfc3339(),
    })
}

pub async fn admin_users_handler(
    State(_state): State<AppState>,
    RequireAuth(auth): RequireAuth,
) -> Result<Json<serde_json::Value>, ApiError> {
    auth.require_permission(permissions::USERS_READ)?;
    Ok(Json(serde_json::json!({
        "status": "ok",
        "message": "Admin users stub"
    })))
}

pub async fn admin_roles_handler(
    State(_state): State<AppState>,
    RequireAuth(auth): RequireAuth,
) -> Result<Json<serde_json::Value>, ApiError> {
    auth.require_permission(permissions::ROLES_READ)?;
    Ok(Json(serde_json::json!({
        "status": "ok",
        "message": "Admin roles stub"
    })))
}

pub async fn admin_sources_handler(
    State(_state): State<AppState>,
    RequireAuth(auth): RequireAuth,
) -> Result<Json<serde_json::Value>, ApiError> {
    auth.require_permission(permissions::ADMIN_HEALTH)?;
    Ok(Json(serde_json::json!({
        "status": "ok",
        "message": "Admin sources stub"
    })))
}

pub async fn admin_tax_rates_handler(
    State(_state): State<AppState>,
    RequireAuth(auth): RequireAuth,
) -> Result<Json<serde_json::Value>, ApiError> {
    auth.require_permission(permissions::VAT_READ)?;
    Ok(Json(serde_json::json!({
        "status": "ok",
        "message": "Admin tax-rates stub"
    })))
}

pub async fn admin_models_handler(
    State(_state): State<AppState>,
    RequireAuth(auth): RequireAuth,
) -> Result<Json<serde_json::Value>, ApiError> {
    auth.require_permission(permissions::ADMIN_HEALTH)?;
    Ok(Json(serde_json::json!({
        "status": "ok",
        "message": "Admin models stub"
    })))
}
