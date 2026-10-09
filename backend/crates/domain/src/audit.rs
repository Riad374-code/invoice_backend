use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuditEvent {
    pub id: Uuid,
    pub company_id: Uuid,
    pub actor_id: Option<Uuid>,
    pub action: String,
    pub resource_type: String,
    pub resource_id: String,
    pub before: Option<serde_json::Value>,
    pub after: Option<serde_json::Value>,
    pub request_id: String,
    pub created_at: DateTime<Utc>,
}

impl AuditEvent {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        company_id: Uuid,
        actor_id: Option<Uuid>,
        action: impl Into<String>,
        resource_type: impl Into<String>,
        resource_id: impl Into<String>,
        before: Option<serde_json::Value>,
        after: Option<serde_json::Value>,
        request_id: impl Into<String>,
    ) -> Self {
        Self {
            id: Uuid::new_v4(),
            company_id,
            actor_id,
            action: action.into(),
            resource_type: resource_type.into(),
            resource_id: resource_id.into(),
            before,
            after,
            request_id: request_id.into(),
            created_at: Utc::now(),
        }
    }
}
