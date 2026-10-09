use axum::extract::{Extension, State};
use axum::http::header::{HeaderMap, SET_COOKIE};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::ApiError;
use crate::middleware::auth::RequireAuth;
use crate::middleware::request_id::RequestId;
use crate::security::{
    create_access_token, generate_csrf_token, generate_refresh_token, hash_refresh_token,
    verify_password,
};
use crate::state::AppState;
use lexaudit_domain::{Session, UserStatus};

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
    pub mfa_code: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthResponse {
    pub access_token: String,
    pub csrf_token: String,
    pub expires_in_seconds: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeResponse {
    pub id: Uuid,
    pub email: String,
    pub status: String,
    pub company_id: Uuid,
    pub company_name: Option<String>,
    pub roles: Vec<String>,
    pub permissions: Vec<String>,
}

/// POST /api/v1/auth/login
pub async fn login_handler(
    State(state): State<AppState>,
    Extension(RequestId(req_id)): Extension<RequestId>,
    headers: HeaderMap,
    Json(payload): Json<LoginRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let email = payload.email.trim();
    if email.is_empty() || payload.password.is_empty() {
        return Err(ApiError::ValidationFailed(
            "Email and password must not be empty".to_string(),
        ));
    }

    // Rate limiting (Audit A-01)
    let rate_limit_key = format!("login:{email}");
    let allowed = state.rate_limiter.check(&rate_limit_key, 10, 60).await;
    if !allowed {
        return Err(ApiError::RateLimited(
            "Too many login attempts. Please wait 1 minute before retrying.".to_string(),
        ));
    }

    let user = state
        .user_repo
        .find_user_by_email(email)
        .await?
        .ok_or_else(|| ApiError::Unauthenticated("Invalid credentials".to_string()))?;

    if user.status != UserStatus::Active {
        return Err(ApiError::Forbidden(
            "User account is not active".to_string(),
        ));
    }

    let pass_valid = verify_password(&payload.password, &user.password_hash)?;
    if !pass_valid {
        return Err(ApiError::Unauthenticated("Invalid credentials".to_string()));
    }

    let roles = state.role_repo.get_user_roles(user.id).await?;
    let role_names: Vec<String> = roles.into_iter().map(|r| r.name).collect();

    let perms = state.role_repo.get_user_permissions(user.id).await?;
    let perm_codes: Vec<String> = perms.into_iter().map(|p| p.code).collect();

    let access_token = create_access_token(
        user.id,
        user.company_id,
        &user.email,
        role_names.clone(),
        perm_codes.clone(),
        state.config.access_token_ttl_minutes,
        &state.config.jwt_secret,
    )?;

    // Refresh token generation & database session storage
    let refresh_token = generate_refresh_token();
    let refresh_hash = hash_refresh_token(&refresh_token);
    let now = Utc::now();
    let expires_at = now + Duration::days(state.config.refresh_token_ttl_days);

    let ip = headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let user_agent = headers
        .get("user-agent")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let session = Session {
        id: Uuid::new_v4(),
        company_id: user.company_id,
        user_id: user.id,
        refresh_token_hash: refresh_hash,
        expires_at,
        revoked_at: None,
        ip,
        user_agent,
        created_at: now,
        updated_at: now,
    };
    state.session_repo.create_session(&session).await?;

    let csrf_token = generate_csrf_token(&state.config.csrf_secret);

    // Audit log mutating action
    let _ = state
        .audit_logger
        .log(
            user.company_id,
            Some(user.id),
            "auth.login",
            "session",
            session.id.to_string(),
            None,
            Some(serde_json::json!({ "user_id": user.id, "email": user.email })),
            req_id,
        )
        .await;

    let cookie_val = format!(
        "refresh_token={}; HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth; Max-Age={}",
        refresh_token,
        state.config.refresh_token_ttl_days * 86400
    );

    let mut response_headers = HeaderMap::new();
    if let Ok(c) = cookie_val.parse() {
        response_headers.insert(SET_COOKIE, c);
    }

    let body = Json(AuthResponse {
        access_token,
        csrf_token,
        expires_in_seconds: state.config.access_token_ttl_minutes * 60,
    });

    Ok((StatusCode::OK, response_headers, body))
}

/// POST /api/v1/auth/refresh (Audit A-07: dynamic expiry & refresh rotation)
pub async fn refresh_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    let refresh_token = headers
        .get("cookie")
        .and_then(|v| v.to_str().ok())
        .and_then(|cookie_str| {
            cookie_str.split(';').find_map(|pair| {
                let mut parts = pair.trim().splitn(2, '=');
                let name = parts.next()?;
                let val = parts.next()?;
                if name == "refresh_token" {
                    Some(val.to_string())
                } else {
                    None
                }
            })
        })
        .or_else(|| {
            headers
                .get("x-refresh-token")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string())
        })
        .ok_or_else(|| ApiError::Unauthenticated("Missing refresh token cookie".to_string()))?;

    let hash = hash_refresh_token(&refresh_token);
    let now = Utc::now();

    let old_session = state
        .session_repo
        .find_active_session_by_hash(&hash, now)
        .await?
        .ok_or_else(|| {
            ApiError::Unauthenticated("Invalid, expired, or revoked refresh token".to_string())
        })?;

    // Refresh Rotation: Revoke old session immediately (A-07)
    state.session_repo.revoke_session(old_session.id, now).await?;

    let user = state
        .user_repo
        .find_user_by_id(old_session.user_id)
        .await?
        .ok_or_else(|| ApiError::Unauthenticated("User associated with session not found".to_string()))?;

    if user.status != UserStatus::Active {
        return Err(ApiError::Forbidden("User account is inactive".to_string()));
    }

    let roles = state.role_repo.get_user_roles(user.id).await?;
    let role_names: Vec<String> = roles.into_iter().map(|r| r.name).collect();

    let perms = state.role_repo.get_user_permissions(user.id).await?;
    let perm_codes: Vec<String> = perms.into_iter().map(|p| p.code).collect();

    let new_access_token = create_access_token(
        user.id,
        user.company_id,
        &user.email,
        role_names,
        perm_codes,
        state.config.access_token_ttl_minutes,
        &state.config.jwt_secret,
    )?;

    // Create new rotated session
    let new_refresh_token = generate_refresh_token();
    let new_refresh_hash = hash_refresh_token(&new_refresh_token);
    let new_expires_at = now + Duration::days(state.config.refresh_token_ttl_days);

    let new_session = Session {
        id: Uuid::new_v4(),
        company_id: user.company_id,
        user_id: user.id,
        refresh_token_hash: new_refresh_hash,
        expires_at: new_expires_at,
        revoked_at: None,
        ip: old_session.ip,
        user_agent: old_session.user_agent,
        created_at: now,
        updated_at: now,
    };
    state.session_repo.create_session(&new_session).await?;

    let csrf_token = generate_csrf_token(&state.config.csrf_secret);

    let cookie_val = format!(
        "refresh_token={}; HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth; Max-Age={}",
        new_refresh_token,
        state.config.refresh_token_ttl_days * 86400
    );

    let mut response_headers = HeaderMap::new();
    if let Ok(c) = cookie_val.parse() {
        response_headers.insert(SET_COOKIE, c);
    }

    let body = Json(AuthResponse {
        access_token: new_access_token,
        csrf_token,
        expires_in_seconds: state.config.access_token_ttl_minutes * 60,
    });

    Ok((StatusCode::OK, response_headers, body))
}

/// POST /api/v1/auth/logout
pub async fn logout_handler(
    State(state): State<AppState>,
    Extension(RequestId(req_id)): Extension<RequestId>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    if let Some(refresh_token) = headers
        .get("cookie")
        .and_then(|v| v.to_str().ok())
        .and_then(|cookie_str| {
            cookie_str.split(';').find_map(|pair| {
                let mut parts = pair.trim().splitn(2, '=');
                let name = parts.next()?;
                let val = parts.next()?;
                if name == "refresh_token" {
                    Some(val.to_string())
                } else {
                    None
                }
            })
        })
    {
        let hash = hash_refresh_token(&refresh_token);
        let now = Utc::now();
        if let Ok(Some(session)) = state.session_repo.find_active_session_by_hash(&hash, now).await {
            let _ = state.session_repo.revoke_session(session.id, now).await;
            let _ = state
                .audit_logger
                .log(
                    session.company_id,
                    Some(session.user_id),
                    "auth.logout",
                    "session",
                    session.id.to_string(),
                    None,
                    None,
                    req_id,
                )
                .await;
        }
    }

    // Clear cookie
    let clear_cookie = "refresh_token=; HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth; Max-Age=0";
    let mut response_headers = HeaderMap::new();
    if let Ok(c) = clear_cookie.parse() {
        response_headers.insert(SET_COOKIE, c);
    }

    Ok((StatusCode::OK, response_headers, Json(serde_json::json!({ "status": "ok" }))))
}

/// GET /api/v1/me
pub async fn me_handler(
    State(state): State<AppState>,
    RequireAuth(auth): RequireAuth,
) -> Result<Json<MeResponse>, ApiError> {
    let user = state
        .user_repo
        .find_user_by_id(auth.user_id)
        .await?
        .ok_or_else(|| ApiError::NotFound("User not found".to_string()))?;

    let company = state.company_repo.find_company_by_id(auth.company_id).await?;

    Ok(Json(MeResponse {
        id: user.id,
        email: user.email,
        status: user.status.to_string(),
        company_id: auth.company_id,
        company_name: company.map(|c| c.name),
        roles: auth.roles,
        permissions: auth.permissions,
    }))
}
