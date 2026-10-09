use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::middleware::auth::RequireAuth;
use crate::state::AppState;
use lexaudit_domain::permissions;

pub async fn list_invoices_handler(
    State(_state): State<AppState>,
    RequireAuth(auth): RequireAuth,
) -> Result<Json<Value>, ApiError> {
    auth.require_permission(permissions::INVOICES_READ)?;
    Ok(Json(json!({
        "status": "ok",
        "message": "Invoices stub (B06)",
        "invoices": []
    })))
}

pub async fn list_vat_periods_handler(
    State(_state): State<AppState>,
    RequireAuth(auth): RequireAuth,
) -> Result<Json<Value>, ApiError> {
    auth.require_permission(permissions::VAT_READ)?;
    Ok(Json(json!({
        "status": "ok",
        "message": "VAT periods stub (B11)",
        "periods": []
    })))
}

pub async fn list_journal_handler(
    State(_state): State<AppState>,
    RequireAuth(auth): RequireAuth,
) -> Result<Json<Value>, ApiError> {
    auth.require_permission(permissions::JOURNAL_READ)?;
    Ok(Json(json!({
        "status": "ok",
        "message": "Journal entries stub (B05)",
        "entries": []
    })))
}

pub async fn excel_jobs_handler(
    State(_state): State<AppState>,
    RequireAuth(auth): RequireAuth,
) -> Result<Json<Value>, ApiError> {
    auth.require_permission(permissions::INVOICES_READ)?;
    Ok(Json(json!({
        "status": "ok",
        "message": "Excel jobs stub (B12)"
    })))
}

pub async fn reconciliations_handler(
    State(_state): State<AppState>,
    RequireAuth(auth): RequireAuth,
) -> Result<Json<Value>, ApiError> {
    auth.require_permission(permissions::JOURNAL_READ)?;
    Ok(Json(json!({
        "status": "ok",
        "message": "Reconciliations stub (B12)"
    })))
}

pub async fn news_handler(
    State(_state): State<AppState>,
    RequireAuth(auth): RequireAuth,
) -> Result<Json<Value>, ApiError> {
    auth.require_permission(permissions::ADMIN_HEALTH)?;
    Ok(Json(json!({
        "status": "ok",
        "message": "News feed stub (B07)"
    })))
}

pub async fn legislation_handler(
    State(_state): State<AppState>,
    RequireAuth(auth): RequireAuth,
) -> Result<Json<Value>, ApiError> {
    auth.require_permission(permissions::ADMIN_HEALTH)?;
    Ok(Json(json!({
        "status": "ok",
        "message": "Legislation stub (B07)"
    })))
}

pub async fn files_handler(
    State(_state): State<AppState>,
    RequireAuth(auth): RequireAuth,
) -> Result<Json<Value>, ApiError> {
    auth.require_permission(permissions::INVOICES_READ)?;
    Ok(Json(json!({
        "status": "ok",
        "message": "Files storage stub (B04)"
    })))
}

pub async fn assistant_handler(
    State(_state): State<AppState>,
    RequireAuth(auth): RequireAuth,
) -> Result<Json<Value>, ApiError> {
    auth.require_permission(permissions::ADMIN_HEALTH)?;
    Ok(Json(json!({
        "status": "ok",
        "message": "Assistant AI stub (B09)"
    })))
}
