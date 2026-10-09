use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use thiserror::Error;


#[derive(Debug, Serialize, Deserialize)]
pub struct ErrorDetail {
    pub code: String,
    pub message: String,
    #[serde(rename = "requestId")]
    pub request_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ErrorResponse {
    pub error: ErrorDetail,
}

#[derive(Debug, Error)]
pub enum ApiError {
    #[error("Unauthenticated: {0}")]
    Unauthenticated(String),

    #[error("Forbidden: {0}")]
    Forbidden(String),

    #[error("Not Found: {0}")]
    NotFound(String),

    #[error("Validation Failed: {0}")]
    ValidationFailed(String),

    #[error("Conflict: {0}")]
    Conflict(String),

    #[error("Approval Required: {0}")]
    ApprovalRequired(String),

    #[error("Rate Limited: {0}")]
    RateLimited(String),

    #[error("Upstream Unavailable: {0}")]
    UpstreamUnavailable(String),

    #[error("Internal Server Error: {0}")]
    Internal(String),
}

impl ApiError {
    pub fn status_code(&self) -> StatusCode {
        match self {
            Self::Unauthenticated(_) => StatusCode::UNAUTHORIZED,
            Self::Forbidden(_) => StatusCode::FORBIDDEN,
            Self::NotFound(_) => StatusCode::NOT_FOUND,
            Self::ValidationFailed(_) => StatusCode::UNPROCESSABLE_ENTITY,
            Self::Conflict(_) => StatusCode::CONFLICT,
            Self::ApprovalRequired(_) => StatusCode::CONFLICT,
            Self::RateLimited(_) => StatusCode::TOO_MANY_REQUESTS,
            Self::UpstreamUnavailable(_) => StatusCode::SERVICE_UNAVAILABLE,
            Self::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    pub fn error_code(&self) -> &'static str {
        match self {
            Self::Unauthenticated(_) => "UNAUTHENTICATED",
            Self::Forbidden(_) => "FORBIDDEN",
            Self::NotFound(_) => "NOT_FOUND",
            Self::ValidationFailed(_) => "VALIDATION_FAILED",
            Self::Conflict(_) => "CONFLICT",
            Self::ApprovalRequired(_) => "APPROVAL_REQUIRED",
            Self::RateLimited(_) => "RATE_LIMITED",
            Self::UpstreamUnavailable(_) => "UPSTREAM_UNAVAILABLE",
            Self::Internal(_) => "INTERNAL",
        }
    }

    pub fn to_response_with_request_id(&self, request_id: &str) -> (StatusCode, Json<ErrorResponse>) {
        let body = ErrorResponse {
            error: ErrorDetail {
                code: self.error_code().to_string(),
                message: self.to_string(),
                request_id: request_id.to_string(),
            },
        };
        (self.status_code(), Json(body))
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, json) = self.to_response_with_request_id("req_system");
        (status, json).into_response()
    }
}

impl From<lexaudit_domain::DomainError> for ApiError {
    fn from(err: lexaudit_domain::DomainError) -> Self {
        match err {
            lexaudit_domain::DomainError::InvalidStateTransition { reason, .. } => {
                ApiError::Conflict(reason)
            }
            lexaudit_domain::DomainError::SelfApprovalForbidden(msg) => {
                ApiError::Forbidden(msg)
            }
            lexaudit_domain::DomainError::NotFound(msg) => ApiError::NotFound(msg),
            lexaudit_domain::DomainError::Conflict(msg) => ApiError::Conflict(msg),
            lexaudit_domain::DomainError::Validation(msg) => ApiError::ValidationFailed(msg),
            lexaudit_domain::DomainError::Unauthorized(msg) => ApiError::Unauthenticated(msg),
            lexaudit_domain::DomainError::Forbidden(msg) => ApiError::Forbidden(msg),
        }
    }
}

impl From<lexaudit_db::DbError> for ApiError {
    fn from(err: lexaudit_db::DbError) -> Self {
        // Audit A-13: Lock/DB xətası → 5xx, heç vaxt saxta uğur
        match err {
            lexaudit_db::DbError::NotFound(msg) => ApiError::NotFound(msg),
            lexaudit_db::DbError::Conflict(msg) => ApiError::Conflict(msg),
            lexaudit_db::DbError::ConstraintViolation(msg) => ApiError::Conflict(msg),
            lexaudit_db::DbError::ImmutabilityViolation(msg) => ApiError::Conflict(msg),
            lexaudit_db::DbError::Sqlx(e) => {
                tracing::error!("PostgreSQL query error: {e}");
                ApiError::Internal("Database error occurred".to_string())
            }
            lexaudit_db::DbError::Internal(e) => {
                tracing::error!("Internal database error: {e}");
                ApiError::Internal(e)
            }
        }
    }
}
