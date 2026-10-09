//! LexAudit AI — Database Access Layer (SQLx repositories & InMemory test store)

pub mod error;
pub mod in_memory;
pub mod postgres;
pub mod traits;

pub use error::DbError;
pub use in_memory::InMemoryStore;
pub use postgres::PgDb;
pub use traits::{
    ApprovalRepository, AuditRepository, CompanyRepository, RoleRepository, SessionRepository,
    UserRepository,
};

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, Utc};
    use lexaudit_domain::{
        AuditEvent, Company, ReportingStandard, Session, TaxRegime, User, UserStatus,
    };
    use uuid::Uuid;

    #[tokio::test]
    async fn test_in_memory_store_company_and_user() {
        let store = InMemoryStore::new();
        store.seed_defaults().await.unwrap();

        let company = Company {
            id: Uuid::new_v4(),
            name: "Test MMC".to_string(),
            voen: "1234567890".to_string(),
            base_currency: "AZN".to_string(),
            is_vat_payer: true,
            tax_regime: TaxRegime::General,
            reporting_standard: ReportingStandard::Mmus,
            chart_of_accounts_id: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            deleted_at: None,
        };

        let created_c = store.create_company(&company).await.unwrap();
        assert_eq!(created_c.voen, "1234567890");

        // Duplicate VOEN rejection
        let dup = store.create_company(&company).await;
        assert!(dup.is_err());

        let user = User {
            id: Uuid::new_v4(),
            company_id: company.id,
            email: "test@lexaudit.az".to_string(),
            password_hash: "hash123".to_string(),
            status: UserStatus::Active,
            mfa_secret: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            deleted_at: None,
        };

        store.create_user(&user).await.unwrap();
        let found = store.find_user_by_email("TEST@lexaudit.az").await.unwrap();
        assert!(found.is_some());
    }

    #[tokio::test]
    async fn test_in_memory_store_audit_append_only() {
        let store = InMemoryStore::new();
        let cid = Uuid::new_v4();
        let event = AuditEvent::new(
            cid,
            Some(Uuid::new_v4()),
            "invoice.create",
            "invoice",
            "inv-001",
            None,
            Some(serde_json::json!({"net": "100.00"})),
            "req_123",
        );

        store.insert_audit_event(&event).await.unwrap();
        let events = store.list_audit_events_by_company(cid, 10).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].action, "invoice.create");
    }

    #[tokio::test]
    async fn test_in_memory_session_rotation() {
        let store = InMemoryStore::new();
        let cid = Uuid::new_v4();
        let uid = Uuid::new_v4();
        let now = Utc::now();

        let session = Session {
            id: Uuid::new_v4(),
            company_id: cid,
            user_id: uid,
            refresh_token_hash: "sha_hash_1".to_string(),
            expires_at: now + Duration::days(30),
            revoked_at: None,
            ip: Some("127.0.0.1".into()),
            user_agent: Some("Mozilla".into()),
            created_at: now,
            updated_at: now,
        };

        store.create_session(&session).await.unwrap();
        let active = store.find_active_session_by_hash("sha_hash_1", now).await.unwrap();
        assert!(active.is_some());

        // Revoke
        store.revoke_session(session.id, now).await.unwrap();
        let revoked = store.find_active_session_by_hash("sha_hash_1", now).await.unwrap();
        assert!(revoked.is_none());
    }
}
