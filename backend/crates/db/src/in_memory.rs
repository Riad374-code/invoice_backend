use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use lexaudit_domain::{
    Approval, AuditEvent, Company, Permission, Role, Session, User, UserStatus,
};
use uuid::Uuid;

use crate::error::DbError;
use crate::traits::{
    ApprovalRepository, AuditRepository, CompanyRepository, RoleRepository, SessionRepository,
    UserRepository,
};

#[derive(Default, Clone)]
pub struct InMemoryStore {
    companies: Arc<RwLock<HashMap<Uuid, Company>>>,
    users: Arc<RwLock<HashMap<Uuid, User>>>,
    sessions: Arc<RwLock<HashMap<Uuid, Session>>>,
    roles: Arc<RwLock<HashMap<Uuid, Role>>>,
    permissions: Arc<RwLock<HashMap<Uuid, Permission>>>,
    role_permissions: Arc<RwLock<Vec<(Uuid, Uuid)>>>,
    user_roles: Arc<RwLock<Vec<(Uuid, Uuid)>>>,
    audit_events: Arc<RwLock<Vec<AuditEvent>>>,
    approvals: Arc<RwLock<HashMap<Uuid, Approval>>>,
}

impl InMemoryStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Seeds standard base permissions and an admin role.
    pub async fn seed_defaults(&self) -> Result<(), DbError> {
        use lexaudit_domain::permissions::*;

        let default_perms = [
            (USERS_READ, "Read user accounts"),
            (USERS_WRITE, "Manage user accounts"),
            (ROLES_READ, "Read roles and permissions"),
            (ROLES_WRITE, "Manage roles and permissions"),
            (INVOICES_READ, "Read invoices"),
            (INVOICES_WRITE, "Create and update invoices"),
            (VAT_READ, "Read VAT calculations and returns"),
            (VAT_WRITE, "Manage VAT returns"),
            (JOURNAL_READ, "Read accounting journal entries"),
            (JOURNAL_WRITE, "Submit accounting journal entries"),
            (APPROVALS_READ, "List approval requests"),
            (APPROVALS_DECIDE, "Decide on approval requests"),
            (AUDIT_READ, "Read immutable audit logs"),
            (ADMIN_HEALTH, "Check system health and metrics"),
        ];

        let mut perm_ids = Vec::new();
        for (code, desc) in default_perms {
            let perm = Permission {
                id: Uuid::new_v4(),
                code: code.to_string(),
                description: Some(desc.to_string()),
                created_at: Utc::now(),
            };
            self.create_permission(&perm).await?;
            perm_ids.push(perm.id);
        }

        let admin_role = Role {
            id: Uuid::new_v4(),
            company_id: None,
            name: "admin".to_string(),
            description: Some("System Administrator with all permissions".to_string()),
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };
        self.create_role(&admin_role).await?;

        for perm_id in perm_ids {
            self.grant_permission_to_role(admin_role.id, perm_id).await?;
        }

        Ok(())
    }
}

#[async_trait]
impl CompanyRepository for InMemoryStore {
    async fn create_company(&self, company: &Company) -> Result<Company, DbError> {
        let mut map = self.companies.write().await;
        for c in map.values() {
            if c.voen == company.voen {
                return Err(DbError::Conflict(format!("Company with VÖEN {} already exists", company.voen)));
            }
        }
        map.insert(company.id, company.clone());
        Ok(company.clone())
    }

    async fn find_company_by_id(&self, id: Uuid) -> Result<Option<Company>, DbError> {
        let map = self.companies.read().await;
        Ok(map.get(&id).cloned())
    }

    async fn find_company_by_voen(&self, voen: &str) -> Result<Option<Company>, DbError> {
        let map = self.companies.read().await;
        Ok(map.values().find(|c| c.voen == voen).cloned())
    }
}

#[async_trait]
impl UserRepository for InMemoryStore {
    async fn create_user(&self, user: &User) -> Result<User, DbError> {
        let mut map = self.users.write().await;
        for u in map.values() {
            if u.email.eq_ignore_ascii_case(&user.email) {
                return Err(DbError::Conflict(format!("User with email {} already exists", user.email)));
            }
        }
        map.insert(user.id, user.clone());
        Ok(user.clone())
    }

    async fn find_user_by_id(&self, id: Uuid) -> Result<Option<User>, DbError> {
        let map = self.users.read().await;
        Ok(map.get(&id).cloned())
    }

    async fn find_user_by_email(&self, email: &str) -> Result<Option<User>, DbError> {
        let map = self.users.read().await;
        Ok(map.values().find(|u| u.email.eq_ignore_ascii_case(email)).cloned())
    }

    async fn update_user_status(&self, id: Uuid, status: UserStatus) -> Result<(), DbError> {
        let mut map = self.users.write().await;
        if let Some(user) = map.get_mut(&id) {
            user.status = status;
            user.updated_at = Utc::now();
            Ok(())
        } else {
            Err(DbError::NotFound(format!("User {id} not found")))
        }
    }
}

#[async_trait]
impl SessionRepository for InMemoryStore {
    async fn create_session(&self, session: &Session) -> Result<Session, DbError> {
        let mut map = self.sessions.write().await;
        map.insert(session.id, session.clone());
        Ok(session.clone())
    }

    async fn find_active_session_by_hash(
        &self,
        hash: &str,
        now: DateTime<Utc>,
    ) -> Result<Option<Session>, DbError> {
        let map = self.sessions.read().await;
        Ok(map
            .values()
            .find(|s| s.refresh_token_hash == hash && s.is_active(now))
            .cloned())
    }

    async fn revoke_session(&self, id: Uuid, now: DateTime<Utc>) -> Result<(), DbError> {
        let mut map = self.sessions.write().await;
        if let Some(session) = map.get_mut(&id) {
            session.revoke(now);
            Ok(())
        } else {
            Err(DbError::NotFound(format!("Session {id} not found")))
        }
    }
}

#[async_trait]
impl RoleRepository for InMemoryStore {
    async fn get_user_roles(&self, user_id: Uuid) -> Result<Vec<Role>, DbError> {
        let ur = self.user_roles.read().await;
        let role_ids: Vec<Uuid> = ur
            .iter()
            .filter(|(uid, _)| *uid == user_id)
            .map(|(_, rid)| *rid)
            .collect();

        let roles_map = self.roles.read().await;
        Ok(role_ids
            .into_iter()
            .filter_map(|rid| roles_map.get(&rid).cloned())
            .collect())
    }

    async fn get_user_permissions(&self, user_id: Uuid) -> Result<Vec<Permission>, DbError> {
        let user_roles = self.get_user_roles(user_id).await?;
        let role_ids: Vec<Uuid> = user_roles.into_iter().map(|r| r.id).collect();

        let rp = self.role_permissions.read().await;
        let perm_ids: Vec<Uuid> = rp
            .iter()
            .filter(|(rid, _)| role_ids.contains(rid))
            .map(|(_, pid)| *pid)
            .collect();

        let perms_map = self.permissions.read().await;
        let mut permissions = Vec::new();
        for pid in perm_ids {
            if let Some(p) = perms_map.get(&pid) {
                if !permissions.iter().any(|existing: &Permission| existing.id == p.id) {
                    permissions.push(p.clone());
                }
            }
        }
        Ok(permissions)
    }

    async fn assign_role_to_user(&self, user_id: Uuid, role_id: Uuid) -> Result<(), DbError> {
        let mut ur = self.user_roles.write().await;
        if !ur.iter().any(|(u, r)| *u == user_id && *r == role_id) {
            ur.push((user_id, role_id));
        }
        Ok(())
    }

    async fn create_role(&self, role: &Role) -> Result<Role, DbError> {
        let mut map = self.roles.write().await;
        map.insert(role.id, role.clone());
        Ok(role.clone())
    }

    async fn create_permission(&self, permission: &Permission) -> Result<Permission, DbError> {
        let mut map = self.permissions.write().await;
        map.insert(permission.id, permission.clone());
        Ok(permission.clone())
    }

    async fn grant_permission_to_role(
        &self,
        role_id: Uuid,
        permission_id: Uuid,
    ) -> Result<(), DbError> {
        let mut rp = self.role_permissions.write().await;
        if !rp.iter().any(|(r, p)| *r == role_id && *p == permission_id) {
            rp.push((role_id, permission_id));
        }
        Ok(())
    }
}

#[async_trait]
impl AuditRepository for InMemoryStore {
    async fn insert_audit_event(&self, event: &AuditEvent) -> Result<(), DbError> {
        let mut list = self.audit_events.write().await;
        list.push(event.clone());
        Ok(())
    }

    async fn list_audit_events_by_company(
        &self,
        company_id: Uuid,
        limit: i64,
    ) -> Result<Vec<AuditEvent>, DbError> {
        let list = self.audit_events.read().await;
        let mut events: Vec<AuditEvent> = list
            .iter()
            .filter(|e| e.company_id == company_id)
            .cloned()
            .collect();
        events.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        if limit > 0 && events.len() > limit as usize {
            events.truncate(limit as usize);
        }
        Ok(events)
    }
}

#[async_trait]
impl ApprovalRepository for InMemoryStore {
    async fn create_approval(&self, approval: &Approval) -> Result<Approval, DbError> {
        let mut map = self.approvals.write().await;
        map.insert(approval.id, approval.clone());
        Ok(approval.clone())
    }

    async fn find_approval_by_id(&self, id: Uuid) -> Result<Option<Approval>, DbError> {
        let map = self.approvals.read().await;
        Ok(map.get(&id).cloned())
    }

    async fn list_approvals_by_company(&self, company_id: Uuid) -> Result<Vec<Approval>, DbError> {
        let map = self.approvals.read().await;
        let mut list: Vec<Approval> = map
            .values()
            .filter(|a| a.company_id == company_id)
            .cloned()
            .collect();
        list.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(list)
    }

    async fn update_approval_decision(&self, approval: &Approval) -> Result<(), DbError> {
        // Audit A-03 constraint check
        if let Some(approver_id) = approval.approver_id {
            if approver_id == approval.requester_id {
                return Err(DbError::ConstraintViolation(
                    "CHECK violation: approver_id cannot equal requester_id (Audit A-03)".into(),
                ));
            }
        }

        let mut map = self.approvals.write().await;
        if let Some(existing) = map.get_mut(&approval.id) {
            *existing = approval.clone();
            Ok(())
        } else {
            Err(DbError::NotFound(format!("Approval {} not found", approval.id)))
        }
    }
}
