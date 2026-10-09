//! LexAudit AI — Domain Models (pure business logic, zero IO)
//! Rule: No database or HTTP dependencies. Fully unit-tested.

pub mod approvals;
pub mod audit;
pub mod error;
pub mod identity;

pub use approvals::{Approval, ApprovalKind, ApprovalStatus};
pub use audit::AuditEvent;
pub use error::DomainError;
pub use identity::{
    permissions, Company, Permission, ReportingStandard, Role, Session, TaxRegime, User,
    UserStatus,
};

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, Utc};
    use uuid::Uuid;

    #[test]
    fn test_user_status_transitions() {
        let status = UserStatus::Pending;
        assert_eq!(status.transition_to(UserStatus::Active).unwrap(), UserStatus::Active);

        let active = UserStatus::Active;
        assert_eq!(active.transition_to(UserStatus::Suspended).unwrap(), UserStatus::Suspended);

        let suspended = UserStatus::Suspended;
        assert_eq!(suspended.transition_to(UserStatus::Active).unwrap(), UserStatus::Active);
    }

    #[test]
    fn test_approval_state_machine_and_self_approval_check() {
        let company_id = Uuid::new_v4();
        let requester_id = Uuid::new_v4();
        let approver_id = Uuid::new_v4();
        let now = Utc::now();
        let expires_at = now + Duration::hours(24);

        let mut approval = Approval::new(
            company_id,
            "journal_post",
            "journal:123",
            serde_json::json!({"amount": 1000}),
            requester_id,
            expires_at,
        );

        // Audit A-03: Self-approval forbidden
        let err = approval.approve(requester_id, Some("Self ok".into()), now);
        assert!(matches!(err, Err(DomainError::SelfApprovalForbidden(_))));

        // Valid approval by different user
        let ok = approval.approve(approver_id, Some("Looks good".into()), now);
        assert!(ok.is_ok());
        assert_eq!(approval.status, ApprovalStatus::Approved);
        assert_eq!(approval.approver_id, Some(approver_id));

        // Audit A-04: Cannot transition from Approved state
        let err2 = approval.reject(approver_id, Some("Changed mind".into()), now);
        assert!(matches!(err2, Err(DomainError::InvalidStateTransition { .. })));
    }
}
