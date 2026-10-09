use async_trait::async_trait;
use chrono::{DateTime, Utc};
use lexaudit_domain::{
    Approval, ApprovalStatus, AuditEvent, Company, Permission, ReportingStandard, Role, Session,
    TaxRegime, User, UserStatus,
};
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Row};
use std::str::FromStr;
use uuid::Uuid;

use crate::error::DbError;
use crate::traits::{
    ApprovalRepository, AuditRepository, CompanyRepository, RoleRepository, SessionRepository,
    UserRepository,
};

#[derive(Clone)]
pub struct PgDb {
    pool: PgPool,
}

impl PgDb {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn connect(database_url: &str) -> Result<Self, DbError> {
        let pool = PgPoolOptions::new()
            .max_connections(20)
            .connect(database_url)
            .await?;
        Ok(Self { pool })
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }
}

#[async_trait]
impl CompanyRepository for PgDb {
    async fn create_company(&self, company: &Company) -> Result<Company, DbError> {
        sqlx::query(
            r#"
            INSERT INTO companies (
                id, name, voen, base_currency, is_vat_payer, tax_regime,
                reporting_standard, chart_of_accounts_id, created_at, updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            "#,
        )
        .bind(company.id)
        .bind(&company.name)
        .bind(&company.voen)
        .bind(&company.base_currency)
        .bind(company.is_vat_payer)
        .bind(company.tax_regime.to_string())
        .bind(company.reporting_standard.to_string())
        .bind(company.chart_of_accounts_id)
        .bind(company.created_at)
        .bind(company.updated_at)
        .execute(&self.pool)
        .await?;

        Ok(company.clone())
    }

    async fn find_company_by_id(&self, id: Uuid) -> Result<Option<Company>, DbError> {
        let row = sqlx::query(
            r#"
            SELECT id, name, voen, base_currency, is_vat_payer, tax_regime,
                   reporting_standard, chart_of_accounts_id, created_at, updated_at, deleted_at
            FROM companies
            WHERE id = $1 AND deleted_at IS NULL
            "#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;

        match row {
            Some(row) => {
                let regime_str: String = row.try_get("tax_regime")?;
                let standard_str: String = row.try_get("reporting_standard")?;
                Ok(Some(Company {
                    id: row.try_get("id")?,
                    name: row.try_get("name")?,
                    voen: row.try_get("voen")?,
                    base_currency: row.try_get("base_currency")?,
                    is_vat_payer: row.try_get("is_vat_payer")?,
                    tax_regime: TaxRegime::from_str(&regime_str)
                        .map_err(|e| DbError::Internal(e.to_string()))?,
                    reporting_standard: ReportingStandard::from_str(&standard_str)
                        .map_err(|e| DbError::Internal(e.to_string()))?,
                    chart_of_accounts_id: row.try_get("chart_of_accounts_id")?,
                    created_at: row.try_get("created_at")?,
                    updated_at: row.try_get("updated_at")?,
                    deleted_at: row.try_get("deleted_at")?,
                }))
            }
            None => Ok(None),
        }
    }

    async fn find_company_by_voen(&self, voen: &str) -> Result<Option<Company>, DbError> {
        let row = sqlx::query(
            r#"
            SELECT id, name, voen, base_currency, is_vat_payer, tax_regime,
                   reporting_standard, chart_of_accounts_id, created_at, updated_at, deleted_at
            FROM companies
            WHERE voen = $1 AND deleted_at IS NULL
            "#,
        )
        .bind(voen)
        .fetch_optional(&self.pool)
        .await?;

        match row {
            Some(row) => {
                let regime_str: String = row.try_get("tax_regime")?;
                let standard_str: String = row.try_get("reporting_standard")?;
                Ok(Some(Company {
                    id: row.try_get("id")?,
                    name: row.try_get("name")?,
                    voen: row.try_get("voen")?,
                    base_currency: row.try_get("base_currency")?,
                    is_vat_payer: row.try_get("is_vat_payer")?,
                    tax_regime: TaxRegime::from_str(&regime_str)
                        .map_err(|e| DbError::Internal(e.to_string()))?,
                    reporting_standard: ReportingStandard::from_str(&standard_str)
                        .map_err(|e| DbError::Internal(e.to_string()))?,
                    chart_of_accounts_id: row.try_get("chart_of_accounts_id")?,
                    created_at: row.try_get("created_at")?,
                    updated_at: row.try_get("updated_at")?,
                    deleted_at: row.try_get("deleted_at")?,
                }))
            }
            None => Ok(None),
        }
    }
}

#[async_trait]
impl UserRepository for PgDb {
    async fn create_user(&self, user: &User) -> Result<User, DbError> {
        sqlx::query(
            r#"
            INSERT INTO users (id, company_id, email, password_hash, status, mfa_secret, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            "#,
        )
        .bind(user.id)
        .bind(user.company_id)
        .bind(&user.email)
        .bind(&user.password_hash)
        .bind(user.status.to_string())
        .bind(&user.mfa_secret)
        .bind(user.created_at)
        .bind(user.updated_at)
        .execute(&self.pool)
        .await?;

        Ok(user.clone())
    }

    async fn find_user_by_id(&self, id: Uuid) -> Result<Option<User>, DbError> {
        let row = sqlx::query(
            r#"
            SELECT id, company_id, email, password_hash, status, mfa_secret, created_at, updated_at, deleted_at
            FROM users
            WHERE id = $1 AND deleted_at IS NULL
            "#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;

        match row {
            Some(row) => {
                let status_str: String = row.try_get("status")?;
                Ok(Some(User {
                    id: row.try_get("id")?,
                    company_id: row.try_get("company_id")?,
                    email: row.try_get("email")?,
                    password_hash: row.try_get("password_hash")?,
                    status: UserStatus::from_str(&status_str)
                        .map_err(|e| DbError::Internal(e.to_string()))?,
                    mfa_secret: row.try_get("mfa_secret")?,
                    created_at: row.try_get("created_at")?,
                    updated_at: row.try_get("updated_at")?,
                    deleted_at: row.try_get("deleted_at")?,
                }))
            }
            None => Ok(None),
        }
    }

    async fn find_user_by_email(&self, email: &str) -> Result<Option<User>, DbError> {
        let row = sqlx::query(
            r#"
            SELECT id, company_id, email, password_hash, status, mfa_secret, created_at, updated_at, deleted_at
            FROM users
            WHERE LOWER(email) = LOWER($1) AND deleted_at IS NULL
            "#,
        )
        .bind(email)
        .fetch_optional(&self.pool)
        .await?;

        match row {
            Some(row) => {
                let status_str: String = row.try_get("status")?;
                Ok(Some(User {
                    id: row.try_get("id")?,
                    company_id: row.try_get("company_id")?,
                    email: row.try_get("email")?,
                    password_hash: row.try_get("password_hash")?,
                    status: UserStatus::from_str(&status_str)
                        .map_err(|e| DbError::Internal(e.to_string()))?,
                    mfa_secret: row.try_get("mfa_secret")?,
                    created_at: row.try_get("created_at")?,
                    updated_at: row.try_get("updated_at")?,
                    deleted_at: row.try_get("deleted_at")?,
                }))
            }
            None => Ok(None),
        }
    }

    async fn update_user_status(&self, id: Uuid, status: UserStatus) -> Result<(), DbError> {
        let res = sqlx::query(
            r#"
            UPDATE users
            SET status = $1, updated_at = NOW()
            WHERE id = $2 AND deleted_at IS NULL
            "#,
        )
        .bind(status.to_string())
        .bind(id)
        .execute(&self.pool)
        .await?;

        if res.rows_affected() == 0 {
            Err(DbError::NotFound(format!("User {id} not found")))
        } else {
            Ok(())
        }
    }
}

#[async_trait]
impl SessionRepository for PgDb {
    async fn create_session(&self, session: &Session) -> Result<Session, DbError> {
        sqlx::query(
            r#"
            INSERT INTO sessions (id, company_id, user_id, refresh_token_hash, expires_at, revoked_at, ip, user_agent, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            "#,
        )
        .bind(session.id)
        .bind(session.company_id)
        .bind(session.user_id)
        .bind(&session.refresh_token_hash)
        .bind(session.expires_at)
        .bind(session.revoked_at)
        .bind(&session.ip)
        .bind(&session.user_agent)
        .bind(session.created_at)
        .bind(session.updated_at)
        .execute(&self.pool)
        .await?;

        Ok(session.clone())
    }

    async fn find_active_session_by_hash(
        &self,
        hash: &str,
        now: DateTime<Utc>,
    ) -> Result<Option<Session>, DbError> {
        let row = sqlx::query(
            r#"
            SELECT id, company_id, user_id, refresh_token_hash, expires_at, revoked_at, ip, user_agent, created_at, updated_at
            FROM sessions
            WHERE refresh_token_hash = $1 AND revoked_at IS NULL AND expires_at > $2
            "#,
        )
        .bind(hash)
        .bind(now)
        .fetch_optional(&self.pool)
        .await?;

        match row {
            Some(row) => Ok(Some(Session {
                id: row.try_get("id")?,
                company_id: row.try_get("company_id")?,
                user_id: row.try_get("user_id")?,
                refresh_token_hash: row.try_get("refresh_token_hash")?,
                expires_at: row.try_get("expires_at")?,
                revoked_at: row.try_get("revoked_at")?,
                ip: row.try_get("ip")?,
                user_agent: row.try_get("user_agent")?,
                created_at: row.try_get("created_at")?,
                updated_at: row.try_get("updated_at")?,
            })),
            None => Ok(None),
        }
    }

    async fn revoke_session(&self, id: Uuid, now: DateTime<Utc>) -> Result<(), DbError> {
        let res = sqlx::query(
            r#"
            UPDATE sessions
            SET revoked_at = $1, updated_at = $1
            WHERE id = $2 AND revoked_at IS NULL
            "#,
        )
        .bind(now)
        .bind(id)
        .execute(&self.pool)
        .await?;

        if res.rows_affected() == 0 {
            Err(DbError::NotFound(format!("Active session {id} not found")))
        } else {
            Ok(())
        }
    }
}

#[async_trait]
impl RoleRepository for PgDb {
    async fn get_user_roles(&self, user_id: Uuid) -> Result<Vec<Role>, DbError> {
        let rows = sqlx::query(
            r#"
            SELECT r.id, r.company_id, r.name, r.description, r.created_at, r.updated_at
            FROM roles r
            JOIN user_roles ur ON ur.role_id = r.id
            WHERE ur.user_id = $1
            "#,
        )
        .bind(user_id)
        .fetch_all(&self.pool)
        .await?;

        let mut roles = Vec::new();
        for row in rows {
            roles.push(Role {
                id: row.try_get("id")?,
                company_id: row.try_get("company_id")?,
                name: row.try_get("name")?,
                description: row.try_get("description")?,
                created_at: row.try_get("created_at")?,
                updated_at: row.try_get("updated_at")?,
            });
        }
        Ok(roles)
    }

    async fn get_user_permissions(&self, user_id: Uuid) -> Result<Vec<Permission>, DbError> {
        let rows = sqlx::query(
            r#"
            SELECT DISTINCT p.id, p.code, p.description, p.created_at
            FROM permissions p
            JOIN role_permissions rp ON rp.permission_id = p.id
            JOIN user_roles ur ON ur.role_id = rp.role_id
            WHERE ur.user_id = $1
            "#,
        )
        .bind(user_id)
        .fetch_all(&self.pool)
        .await?;

        let mut perms = Vec::new();
        for row in rows {
            perms.push(Permission {
                id: row.try_get("id")?,
                code: row.try_get("code")?,
                description: row.try_get("description")?,
                created_at: row.try_get("created_at")?,
            });
        }
        Ok(perms)
    }

    async fn assign_role_to_user(&self, user_id: Uuid, role_id: Uuid) -> Result<(), DbError> {
        sqlx::query(
            r#"
            INSERT INTO user_roles (user_id, role_id, created_at)
            VALUES ($1, $2, NOW())
            ON CONFLICT (user_id, role_id) DO NOTHING
            "#,
        )
        .bind(user_id)
        .bind(role_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn create_role(&self, role: &Role) -> Result<Role, DbError> {
        sqlx::query(
            r#"
            INSERT INTO roles (id, company_id, name, description, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6)
            "#,
        )
        .bind(role.id)
        .bind(role.company_id)
        .bind(&role.name)
        .bind(&role.description)
        .bind(role.created_at)
        .bind(role.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(role.clone())
    }

    async fn create_permission(&self, permission: &Permission) -> Result<Permission, DbError> {
        sqlx::query(
            r#"
            INSERT INTO permissions (id, code, description, created_at)
            VALUES ($1, $2, $3, $4)
            "#,
        )
        .bind(permission.id)
        .bind(&permission.code)
        .bind(&permission.description)
        .bind(permission.created_at)
        .execute(&self.pool)
        .await?;
        Ok(permission.clone())
    }

    async fn grant_permission_to_role(
        &self,
        role_id: Uuid,
        permission_id: Uuid,
    ) -> Result<(), DbError> {
        sqlx::query(
            r#"
            INSERT INTO role_permissions (role_id, permission_id, created_at)
            VALUES ($1, $2, NOW())
            ON CONFLICT (role_id, permission_id) DO NOTHING
            "#,
        )
        .bind(role_id)
        .bind(permission_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

#[async_trait]
impl AuditRepository for PgDb {
    async fn insert_audit_event(&self, event: &AuditEvent) -> Result<(), DbError> {
        sqlx::query(
            r#"
            INSERT INTO audit_events (
                id, company_id, actor_id, action, resource_type, resource_id,
                before, after, request_id, created_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            "#,
        )
        .bind(event.id)
        .bind(event.company_id)
        .bind(event.actor_id)
        .bind(&event.action)
        .bind(&event.resource_type)
        .bind(&event.resource_id)
        .bind(&event.before)
        .bind(&event.after)
        .bind(&event.request_id)
        .bind(event.created_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn list_audit_events_by_company(
        &self,
        company_id: Uuid,
        limit: i64,
    ) -> Result<Vec<AuditEvent>, DbError> {
        let rows = sqlx::query(
            r#"
            SELECT id, company_id, actor_id, action, resource_type, resource_id,
                   before, after, request_id, created_at
            FROM audit_events
            WHERE company_id = $1
            ORDER BY created_at DESC
            LIMIT $2
            "#,
        )
        .bind(company_id)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;

        let mut events = Vec::new();
        for row in rows {
            events.push(AuditEvent {
                id: row.try_get("id")?,
                company_id: row.try_get("company_id")?,
                actor_id: row.try_get("actor_id")?,
                action: row.try_get("action")?,
                resource_type: row.try_get("resource_type")?,
                resource_id: row.try_get("resource_id")?,
                before: row.try_get("before")?,
                after: row.try_get("after")?,
                request_id: row.try_get("request_id")?,
                created_at: row.try_get("created_at")?,
            });
        }
        Ok(events)
    }
}

#[async_trait]
impl ApprovalRepository for PgDb {
    async fn create_approval(&self, approval: &Approval) -> Result<Approval, DbError> {
        sqlx::query(
            r#"
            INSERT INTO approvals (
                id, company_id, kind, resource_ref, payload, requester_id,
                approver_id, status, expires_at, decided_at, comment, created_at, updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            "#,
        )
        .bind(approval.id)
        .bind(approval.company_id)
        .bind(&approval.kind)
        .bind(&approval.resource_ref)
        .bind(&approval.payload)
        .bind(approval.requester_id)
        .bind(approval.approver_id)
        .bind(approval.status.to_string())
        .bind(approval.expires_at)
        .bind(approval.decided_at)
        .bind(&approval.comment)
        .bind(approval.created_at)
        .bind(approval.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(approval.clone())
    }

    async fn find_approval_by_id(&self, id: Uuid) -> Result<Option<Approval>, DbError> {
        let row = sqlx::query(
            r#"
            SELECT id, company_id, kind, resource_ref, payload, requester_id,
                   approver_id, status, expires_at, decided_at, comment, created_at, updated_at
            FROM approvals
            WHERE id = $1
            "#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;

        match row {
            Some(row) => {
                let status_str: String = row.try_get("status")?;
                Ok(Some(Approval {
                    id: row.try_get("id")?,
                    company_id: row.try_get("company_id")?,
                    kind: row.try_get("kind")?,
                    resource_ref: row.try_get("resource_ref")?,
                    payload: row.try_get("payload")?,
                    requester_id: row.try_get("requester_id")?,
                    approver_id: row.try_get("approver_id")?,
                    status: ApprovalStatus::from_str(&status_str)
                        .map_err(|e| DbError::Internal(e.to_string()))?,
                    expires_at: row.try_get("expires_at")?,
                    decided_at: row.try_get("decided_at")?,
                    comment: row.try_get("comment")?,
                    created_at: row.try_get("created_at")?,
                    updated_at: row.try_get("updated_at")?,
                }))
            }
            None => Ok(None),
        }
    }

    async fn list_approvals_by_company(&self, company_id: Uuid) -> Result<Vec<Approval>, DbError> {
        let rows = sqlx::query(
            r#"
            SELECT id, company_id, kind, resource_ref, payload, requester_id,
                   approver_id, status, expires_at, decided_at, comment, created_at, updated_at
            FROM approvals
            WHERE company_id = $1
            ORDER BY created_at DESC
            "#,
        )
        .bind(company_id)
        .fetch_all(&self.pool)
        .await?;

        let mut list = Vec::new();
        for row in rows {
            let status_str: String = row.try_get("status")?;
            list.push(Approval {
                id: row.try_get("id")?,
                company_id: row.try_get("company_id")?,
                kind: row.try_get("kind")?,
                resource_ref: row.try_get("resource_ref")?,
                payload: row.try_get("payload")?,
                requester_id: row.try_get("requester_id")?,
                approver_id: row.try_get("approver_id")?,
                status: ApprovalStatus::from_str(&status_str)
                    .map_err(|e| DbError::Internal(e.to_string()))?,
                expires_at: row.try_get("expires_at")?,
                decided_at: row.try_get("decided_at")?,
                comment: row.try_get("comment")?,
                created_at: row.try_get("created_at")?,
                updated_at: row.try_get("updated_at")?,
            });
        }
        Ok(list)
    }

    async fn update_approval_decision(&self, approval: &Approval) -> Result<(), DbError> {
        let res = sqlx::query(
            r#"
            UPDATE approvals
            SET status = $1, approver_id = $2, decided_at = $3, comment = $4, updated_at = $5
            WHERE id = $6
            "#,
        )
        .bind(approval.status.to_string())
        .bind(approval.approver_id)
        .bind(approval.decided_at)
        .bind(&approval.comment)
        .bind(approval.updated_at)
        .bind(approval.id)
        .execute(&self.pool)
        .await?;

        if res.rows_affected() == 0 {
            Err(DbError::NotFound(format!("Approval {} not found", approval.id)))
        } else {
            Ok(())
        }
    }
}
