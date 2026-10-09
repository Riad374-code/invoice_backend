use axum::extract::FromRequestParts;
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;
use uuid::Uuid;

use crate::error::ApiError;
use crate::security::verify_access_token;

#[derive(Debug, Clone)]
pub struct AuthUser {
    pub user_id: Uuid,
    pub company_id: Uuid,
    pub email: String,
    pub roles: Vec<String>,
    pub permissions: Vec<String>,
}

impl AuthUser {
    pub fn has_permission(&self, perm: &str) -> bool {
        self.permissions.iter().any(|p| p == perm)
    }

    /// Audit A-02: Enforces that the authenticated user possesses the required permission.
    /// Returns 403 FORBIDDEN if the permission is absent.
    pub fn require_permission(&self, perm: &str) -> Result<(), ApiError> {
        if self.has_permission(perm) {
            Ok(())
        } else {
            Err(ApiError::Forbidden(format!(
                "Forbidden: missing required permission '{perm}' (Audit A-02)"
            )))
        }
    }
}

pub struct RequireAuth(pub AuthUser);

impl std::ops::Deref for RequireAuth {
    type Target = AuthUser;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

pub trait AuthConfigProvider: Send + Sync {
    fn jwt_secret(&self) -> &str;
}

#[axum::async_trait]
impl<S> FromRequestParts<S> for RequireAuth
where
    S: Send + Sync + AuthConfigProvider,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let auth_header = parts
            .headers
            .get(AUTHORIZATION)
            .and_then(|val| val.to_str().ok());

        let token = match auth_header {
            Some(header_val) if header_val.starts_with("Bearer ") => {
                header_val.trim_start_matches("Bearer ").trim()
            }
            _ => {
                // Check cookie fallback if present
                let cookie_token = parts
                    .headers
                    .get("cookie")
                    .and_then(|val| val.to_str().ok())
                    .and_then(|cookie_str| {
                        cookie_str.split(';').find_map(|pair| {
                            let mut parts = pair.trim().splitn(2, '=');
                            let name = parts.next()?;
                            let val = parts.next()?;
                            if name == "access_token" {
                                Some(val)
                            } else {
                                None
                            }
                        })
                    });

                match cookie_token {
                    Some(token) => token,
                    None => {
                        return Err(ApiError::Unauthenticated(
                            "Missing or invalid Authorization header (Audit A-02)".to_string(),
                        ));
                    }
                }
            }
        };

        let claims = verify_access_token(token, state.jwt_secret())?;

        Ok(RequireAuth(AuthUser {
            user_id: claims.sub,
            company_id: claims.company_id,
            email: claims.email,
            roles: claims.roles,
            permissions: claims.permissions,
        }))
    }
}
