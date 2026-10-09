use std::sync::Arc;

use lexaudit_audit::AuditLogger;
use lexaudit_db::{
    ApprovalRepository, CompanyRepository, RoleRepository, SessionRepository, UserRepository,
};

use crate::config::AppConfig;
use crate::middleware::auth::AuthConfigProvider;
use crate::middleware::rate_limit::InMemoryRateLimiter;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<AppConfig>,
    pub company_repo: Arc<dyn CompanyRepository>,
    pub user_repo: Arc<dyn UserRepository>,
    pub session_repo: Arc<dyn SessionRepository>,
    pub role_repo: Arc<dyn RoleRepository>,
    pub approval_repo: Arc<dyn ApprovalRepository>,
    pub audit_logger: AuditLogger,
    pub rate_limiter: InMemoryRateLimiter,
}

impl AuthConfigProvider for AppState {
    fn jwt_secret(&self) -> &str {
        &self.config.jwt_secret
    }
}
