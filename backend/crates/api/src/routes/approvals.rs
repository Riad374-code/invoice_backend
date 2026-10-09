use axum::extract::{Extension, Path, State};
use axum::Json;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::ApiError;
use crate::middleware::auth::RequireAuth;
use crate::middleware::request_id::RequestId;
use crate::state::AppState;
use lexaudit_domain::{permissions, Approval};

#[derive(Debug, Deserialize)]
pub struct DecideApprovalRequest {
    pub decision: String, // "approve" or "reject"
    pub comment: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ApprovalResponse {
    pub id: Uuid,
    pub status: String,
    pub approver_id: Option<Uuid>,
    pub decided_at: Option<String>,
    pub comment: Option<String>,
}

impl From<Approval> for ApprovalResponse {
    fn from(a: Approval) -> Self {
        Self {
            id: a.id,
            status: a.status.to_string(),
            approver_id: a.approver_id,
            decided_at: a.decided_at.map(|d| d.to_rfc3339()),
            comment: a.comment,
        }
    }
}

/// GET /api/v1/approvals
pub async fn list_approvals_handler(
    State(state): State<AppState>,
    RequireAuth(auth): RequireAuth,
) -> Result<Json<Vec<ApprovalResponse>>, ApiError> {
    auth.require_permission(permissions::APPROVALS_READ)?;

    // Tenant isolation: always queries by auth.company_id
    let approvals = state.approval_repo.list_approvals_by_company(auth.company_id).await?;
    let res = approvals.into_iter().map(ApprovalResponse::from).collect();
    Ok(Json(res))
}

/// POST /api/v1/approvals/:id/decide
pub async fn decide_approval_handler(
    State(state): State<AppState>,
    RequireAuth(auth): RequireAuth,
    Extension(RequestId(req_id)): Extension<RequestId>,
    Path(id): Path<Uuid>,
    Json(payload): Json<DecideApprovalRequest>,
) -> Result<Json<ApprovalResponse>, ApiError> {
    auth.require_permission(permissions::APPROVALS_DECIDE)?;

    let mut approval = state
        .approval_repo
        .find_approval_by_id(id)
        .await?
        .ok_or_else(|| ApiError::NotFound(format!("Approval {id} not found")))?;

    // Tenant security check
    if approval.company_id != auth.company_id {
        return Err(ApiError::NotFound(format!("Approval {id} not found")));
    }

    let now = Utc::now();
    let before_status = approval.status.to_string();

    match payload.decision.to_lowercase().as_str() {
        "approve" => {
            // Audit A-03 & A-04 checks inside domain state machine
            approval.approve(auth.user_id, payload.comment.clone(), now)?;
        }
        "reject" => {
            // Audit A-03 & A-04 checks inside domain state machine
            approval.reject(auth.user_id, payload.comment.clone(), now)?;
        }
        other => {
            return Err(ApiError::ValidationFailed(format!(
                "Invalid decision '{other}'. Must be 'approve' or 'reject'."
            )));
        }
    }

    // Persist decision
    state.approval_repo.update_approval_decision(&approval).await?;

    // Audit log mutating action
    let _ = state
        .audit_logger
        .log(
            auth.company_id,
            Some(auth.user_id),
            "approval.decide",
            "approval",
            approval.id.to_string(),
            Some(serde_json::json!({ "status": before_status })),
            Some(serde_json::json!({
                "status": approval.status.to_string(),
                "approver_id": auth.user_id,
                "comment": payload.comment
            })),
            req_id,
        )
        .await;

    Ok(Json(ApprovalResponse::from(approval)))
}
