use async_trait::async_trait;
use chrono::{DateTime, Utc};
use lexaudit_domain::{
    Approval, AuditEvent, Company, Permission, Role, Session, User, UserStatus,
};
use uuid::Uuid;

use crate::error::DbError;

#[async_trait]
pub trait CompanyRepository: Send + Sync {
    async fn create_company(&self, company: &Company) -> Result<Company, DbError>;
    async fn find_company_by_id(&self, id: Uuid) -> Result<Option<Company>, DbError>;
    async fn find_company_by_voen(&self, voen: &str) -> Result<Option<Company>, DbError>;
}

#[async_trait]
pub trait UserRepository: Send + Sync {
    async fn create_user(&self, user: &User) -> Result<User, DbError>;
    async fn find_user_by_id(&self, id: Uuid) -> Result<Option<User>, DbError>;
    async fn find_user_by_email(&self, email: &str) -> Result<Option<User>, DbError>;
    async fn update_user_status(&self, id: Uuid, status: UserStatus) -> Result<(), DbError>;
}

#[async_trait]
pub trait SessionRepository: Send + Sync {
    async fn create_session(&self, session: &Session) -> Result<Session, DbError>;
    async fn find_active_session_by_hash(
        &self,
        hash: &str,
        now: DateTime<Utc>,
    ) -> Result<Option<Session>, DbError>;
    async fn revoke_session(&self, id: Uuid, now: DateTime<Utc>) -> Result<(), DbError>;
}

#[async_trait]
pub trait RoleRepository: Send + Sync {
    async fn get_user_roles(&self, user_id: Uuid) -> Result<Vec<Role>, DbError>;
    async fn get_user_permissions(&self, user_id: Uuid) -> Result<Vec<Permission>, DbError>;
    async fn assign_role_to_user(&self, user_id: Uuid, role_id: Uuid) -> Result<(), DbError>;
    async fn create_role(&self, role: &Role) -> Result<Role, DbError>;
    async fn create_permission(&self, permission: &Permission) -> Result<Permission, DbError>;
    async fn grant_permission_to_role(
        &self,
        role_id: Uuid,
        permission_id: Uuid,
    ) -> Result<(), DbError>;
}

/// Audit events repository — Strictly append-only (UPDATE and DELETE are forbidden).
#[async_trait]
pub trait AuditRepository: Send + Sync {
    async fn insert_audit_event(&self, event: &AuditEvent) -> Result<(), DbError>;
    async fn list_audit_events_by_company(
        &self,
        company_id: Uuid,
        limit: i64,
    ) -> Result<Vec<AuditEvent>, DbError>;
}

#[async_trait]
pub trait ApprovalRepository: Send + Sync {
    async fn create_approval(&self, approval: &Approval) -> Result<Approval, DbError>;
    async fn find_approval_by_id(&self, id: Uuid) -> Result<Option<Approval>, DbError>;
    async fn list_approvals_by_company(&self, company_id: Uuid) -> Result<Vec<Approval>, DbError>;
    async fn update_approval_decision(&self, approval: &Approval) -> Result<(), DbError>;
}
