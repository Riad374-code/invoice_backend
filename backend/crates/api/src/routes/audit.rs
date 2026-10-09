use axum::extract::{Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::error::ApiError;
use crate::middleware::auth::RequireAuth;
use crate::state::AppState;
use lexaudit_domain::{permissions, AuditEvent};

#[derive(Debug, Deserialize)]
pub struct AuditQuery {
    pub limit: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct AuditEventResponse {
    pub id: String,
    pub actor_id: Option<String>,
    pub action: String,
    pub resource_type: String,
    pub resource_id: String,
    pub before: Option<serde_json::Value>,
    pub after: Option<serde_json::Value>,
    pub request_id: String,
    pub created_at: String,
}

impl From<AuditEvent> for AuditEventResponse {
    fn from(e: AuditEvent) -> Self {
        Self {
            id: e.id.to_string(),
            actor_id: e.actor_id.map(|id| id.to_string()),
            action: e.action,
            resource_type: e.resource_type,
            resource_id: e.resource_id,
            before: e.before,
            after: e.after,
            request_id: e.request_id,
            created_at: e.created_at.to_rfc3339(),
        }
    }
}

/// GET /api/v1/audit-events
pub async fn list_audit_events_handler(
    State(state): State<AppState>,
    RequireAuth(auth): RequireAuth,
    Query(query): Query<AuditQuery>,
) -> Result<Json<Vec<AuditEventResponse>>, ApiError> {
    auth.require_permission(permissions::AUDIT_READ)?;

    let limit = query.limit.unwrap_or(50).clamp(1, 200);
    let events = state.audit_logger.list(auth.company_id, limit).await?;

    let res = events.into_iter().map(AuditEventResponse::from).collect();
    Ok(Json(res))
}
