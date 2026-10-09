use std::sync::Arc;

use lexaudit_db::{AuditRepository, DbError};
use lexaudit_domain::AuditEvent;
use uuid::Uuid;

use crate::pii::mask_json_value;

#[derive(Clone)]
pub struct AuditLogger {
    repo: Arc<dyn AuditRepository>,
}

impl AuditLogger {
    pub fn new(repo: Arc<dyn AuditRepository>) -> Self {
        Self { repo }
    }

    /// Logs an audit event with PII masking applied.
    /// In accordance with §4.1: INSERT ONLY.
    /// In accordance with A-13: Propagates DB errors without suppressing them.
    #[allow(clippy::too_many_arguments)]
    pub async fn log(
        &self,
        company_id: Uuid,
        actor_id: Option<Uuid>,
        action: impl Into<String>,
        resource_type: impl Into<String>,
        resource_id: impl Into<String>,
        before: Option<serde_json::Value>,
        after: Option<serde_json::Value>,
        request_id: impl Into<String>,
    ) -> Result<AuditEvent, DbError> {
        let masked_before = before.map(|b| mask_json_value(&b));
        let masked_after = after.map(|a| mask_json_value(&a));

        let event = AuditEvent::new(
            company_id,
            actor_id,
            action,
            resource_type,
            resource_id,
            masked_before,
            masked_after,
            request_id,
        );

        self.repo.insert_audit_event(&event).await?;
        Ok(event)
    }

    pub async fn list(
        &self,
        company_id: Uuid,
        limit: i64,
    ) -> Result<Vec<AuditEvent>, DbError> {
        self.repo.list_audit_events_by_company(company_id, limit).await
    }
}
