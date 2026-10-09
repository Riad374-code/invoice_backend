use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::DomainError;

pub type ApprovalKind = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalStatus {
    #[default]
    Pending,
    Approved,
    Rejected,
    Expired,
}

impl std::fmt::Display for ApprovalStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Pending => write!(f, "pending"),
            Self::Approved => write!(f, "approved"),
            Self::Rejected => write!(f, "rejected"),
            Self::Expired => write!(f, "expired"),
        }
    }
}

impl std::str::FromStr for ApprovalStatus {
    type Err = DomainError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "pending" => Ok(Self::Pending),
            "approved" => Ok(Self::Approved),
            "rejected" => Ok(Self::Rejected),
            "expired" => Ok(Self::Expired),
            _ => Err(DomainError::Validation(format!(
                "Invalid approval status: {s}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Approval {
    pub id: Uuid,
    pub company_id: Uuid,
    pub kind: String,
    pub resource_ref: String,
    pub payload: serde_json::Value,
    pub requester_id: Uuid,
    pub approver_id: Option<Uuid>,
    pub status: ApprovalStatus,
    pub expires_at: DateTime<Utc>,
    pub decided_at: Option<DateTime<Utc>>,
    pub comment: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl Approval {
    pub fn new(
        company_id: Uuid,
        kind: impl Into<String>,
        resource_ref: impl Into<String>,
        payload: serde_json::Value,
        requester_id: Uuid,
        expires_at: DateTime<Utc>,
    ) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4(),
            company_id,
            kind: kind.into(),
            resource_ref: resource_ref.into(),
            payload,
            requester_id,
            approver_id: None,
            status: ApprovalStatus::Pending,
            expires_at,
            decided_at: None,
            comment: None,
            created_at: now,
            updated_at: now,
        }
    }

    /// Audit A-03 & A-04: Approves the request.
    /// Strictly verifies `approver_id != requester_id` and checks state transition.
    pub fn approve(
        &mut self,
        approver_id: Uuid,
        comment: Option<String>,
        now: DateTime<Utc>,
    ) -> Result<(), DomainError> {
        if approver_id == self.requester_id {
            return Err(DomainError::SelfApprovalForbidden(
                "Requester cannot approve their own request (Audit A-03)".to_string(),
            ));
        }

        if self.status != ApprovalStatus::Pending {
            return Err(DomainError::InvalidStateTransition {
                from: self.status.to_string(),
                to: ApprovalStatus::Approved.to_string(),
                reason: "Only pending approvals can be approved (Audit A-04)".to_string(),
            });
        }

        if now > self.expires_at {
            self.status = ApprovalStatus::Expired;
            self.updated_at = now;
            return Err(DomainError::InvalidStateTransition {
                from: ApprovalStatus::Expired.to_string(),
                to: ApprovalStatus::Approved.to_string(),
                reason: "Approval has already expired".to_string(),
            });
        }

        self.status = ApprovalStatus::Approved;
        self.approver_id = Some(approver_id);
        self.decided_at = Some(now);
        self.comment = comment;
        self.updated_at = now;
        Ok(())
    }

    /// Audit A-03 & A-04: Rejects the request.
    /// Strictly verifies `approver_id != requester_id` and checks state transition.
    pub fn reject(
        &mut self,
        approver_id: Uuid,
        comment: Option<String>,
        now: DateTime<Utc>,
    ) -> Result<(), DomainError> {
        if approver_id == self.requester_id {
            return Err(DomainError::SelfApprovalForbidden(
                "Requester cannot reject their own request (Audit A-03)".to_string(),
            ));
        }

        if self.status != ApprovalStatus::Pending {
            return Err(DomainError::InvalidStateTransition {
                from: self.status.to_string(),
                to: ApprovalStatus::Rejected.to_string(),
                reason: "Only pending approvals can be rejected (Audit A-04)".to_string(),
            });
        }

        self.status = ApprovalStatus::Rejected;
        self.approver_id = Some(approver_id);
        self.decided_at = Some(now);
        self.comment = comment;
        self.updated_at = now;
        Ok(())
    }

    pub fn mark_expired(&mut self, now: DateTime<Utc>) -> Result<(), DomainError> {
        if self.status != ApprovalStatus::Pending {
            return Err(DomainError::InvalidStateTransition {
                from: self.status.to_string(),
                to: ApprovalStatus::Expired.to_string(),
                reason: "Only pending approvals can expire".to_string(),
            });
        }

        self.status = ApprovalStatus::Expired;
        self.updated_at = now;
        Ok(())
    }
}
