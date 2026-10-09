use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::DomainError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum TaxRegime {
    #[default]
    General,
    Simplified,
}

impl std::fmt::Display for TaxRegime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::General => write!(f, "general"),
            Self::Simplified => write!(f, "simplified"),
        }
    }
}

impl std::str::FromStr for TaxRegime {
    type Err = DomainError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "general" => Ok(Self::General),
            "simplified" => Ok(Self::Simplified),
            _ => Err(DomainError::Validation(format!("Invalid tax regime: {s}"))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "UPPERCASE")]
pub enum ReportingStandard {
    #[default]
    Mmus,
    Mhbs,
}

impl std::fmt::Display for ReportingStandard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Mmus => write!(f, "MMUS"),
            Self::Mhbs => write!(f, "MHBS"),
        }
    }
}

impl std::str::FromStr for ReportingStandard {
    type Err = DomainError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_uppercase().as_str() {
            "MMUS" => Ok(Self::Mmus),
            "MHBS" => Ok(Self::Mhbs),
            _ => Err(DomainError::Validation(format!(
                "Invalid reporting standard: {s}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Company {
    pub id: Uuid,
    pub name: String,
    pub voen: String,
    pub base_currency: String,
    pub is_vat_payer: bool,
    pub tax_regime: TaxRegime,
    pub reporting_standard: ReportingStandard,
    pub chart_of_accounts_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub deleted_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum UserStatus {
    Pending,
    #[default]
    Active,
    Suspended,
}

impl std::fmt::Display for UserStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Pending => write!(f, "pending"),
            Self::Active => write!(f, "active"),
            Self::Suspended => write!(f, "suspended"),
        }
    }
}

impl std::str::FromStr for UserStatus {
    type Err = DomainError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "pending" => Ok(Self::Pending),
            "active" => Ok(Self::Active),
            "suspended" => Ok(Self::Suspended),
            _ => Err(DomainError::Validation(format!("Invalid user status: {s}"))),
        }
    }
}

impl UserStatus {
    pub fn transition_to(&self, new_status: UserStatus) -> Result<UserStatus, DomainError> {
        match (self, new_status) {
            (UserStatus::Pending, UserStatus::Active) => Ok(UserStatus::Active),
            (UserStatus::Pending, UserStatus::Suspended) => Ok(UserStatus::Suspended),
            (UserStatus::Active, UserStatus::Suspended) => Ok(UserStatus::Suspended),
            (UserStatus::Suspended, UserStatus::Active) => Ok(UserStatus::Active),
            (curr, next) if *curr == next => Ok(next),
            (from, to) => Err(DomainError::InvalidStateTransition {
                from: from.to_string(),
                to: to.to_string(),
                reason: "Disallowed user lifecycle state transition".to_string(),
            }),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct User {
    pub id: Uuid,
    pub company_id: Uuid,
    pub email: String,
    pub password_hash: String,
    pub status: UserStatus,
    pub mfa_secret: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub deleted_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Role {
    pub id: Uuid,
    pub company_id: Option<Uuid>,
    pub name: String,
    pub description: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Permission {
    pub id: Uuid,
    pub code: String,
    pub description: Option<String>,
    pub created_at: DateTime<Utc>,
}

pub mod permissions {
    pub const USERS_READ: &str = "users:read";
    pub const USERS_WRITE: &str = "users:write";
    pub const ROLES_READ: &str = "roles:read";
    pub const ROLES_WRITE: &str = "roles:write";
    pub const INVOICES_READ: &str = "invoices:read";
    pub const INVOICES_WRITE: &str = "invoices:write";
    pub const VAT_READ: &str = "vat:read";
    pub const VAT_WRITE: &str = "vat:write";
    pub const JOURNAL_READ: &str = "journal:read";
    pub const JOURNAL_WRITE: &str = "journal:write";
    pub const APPROVALS_READ: &str = "approvals:read";
    pub const APPROVALS_DECIDE: &str = "approvals:decide";
    pub const AUDIT_READ: &str = "audit:read";
    pub const ADMIN_HEALTH: &str = "admin:health";
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Session {
    pub id: Uuid,
    pub company_id: Uuid,
    pub user_id: Uuid,
    pub refresh_token_hash: String,
    pub expires_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
    pub ip: Option<String>,
    pub user_agent: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl Session {
    pub fn is_active(&self, now: DateTime<Utc>) -> bool {
        self.revoked_at.is_none() && self.expires_at > now
    }

    pub fn revoke(&mut self, now: DateTime<Utc>) {
        self.revoked_at = Some(now);
        self.updated_at = now;
    }
}
