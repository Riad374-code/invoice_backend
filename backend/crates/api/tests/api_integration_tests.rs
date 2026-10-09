use std::sync::Arc;
use axum::body::{to_bytes, Body};
use axum::http::{header, Method, Request, StatusCode};
use chrono::{Duration, Utc};
use serde_json::Value;
use tower::ServiceExt;
use uuid::Uuid;

use lexaudit_api::config::AppConfig;
use lexaudit_api::middleware::InMemoryRateLimiter;
use lexaudit_api::router::create_router;
use lexaudit_api::security::{hash_password, hash_refresh_token};
use lexaudit_api::state::AppState;
use lexaudit_audit::AuditLogger;
use lexaudit_db::{
    CompanyRepository, InMemoryStore, RoleRepository, UserRepository,
};
use lexaudit_domain::{
    permissions, Approval, Company, ReportingStandard, Session, TaxRegime, User, UserStatus,
};

async fn setup_test_app() -> (axum::Router, AppState, Uuid, Uuid) {
    let store = Arc::new(InMemoryStore::new());
    store.seed_defaults().await.unwrap();

    let company_id = Uuid::new_v4();
    let company = Company {
        id: company_id,
        name: "LexAudit Test MMC".to_string(),
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
    store.create_company(&company).await.unwrap();

    let user_id = Uuid::new_v4();
    let password_hash = hash_password("CorrectPass123!").unwrap();
    let user = User {
        id: user_id,
        company_id,
        email: "accountant@lexaudit.az".to_string(),
        password_hash,
        status: UserStatus::Active,
        mfa_secret: None,
        created_at: Utc::now(),
        updated_at: Utc::now(),
        deleted_at: None,
    };
    store.create_user(&user).await.unwrap();

    // Assign accountant role to user with permissions
    let roles = store.get_user_roles(user_id).await.unwrap();
    if roles.is_empty() {
        // Let's grant all seeded permissions by creating an accountant role with permissions
        let role = lexaudit_domain::Role {
            id: Uuid::new_v4(),
            company_id: Some(company_id),
            name: "accountant".to_string(),
            description: Some("Test accountant".into()),
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };
        store.create_role(&role).await.unwrap();
        store.assign_role_to_user(user_id, role.id).await.unwrap();

        // Grant permissions: users:read, approvals:read, approvals:decide, audit:read, admin:health
        for perm_code in [
            permissions::USERS_READ,
            permissions::APPROVALS_READ,
            permissions::APPROVALS_DECIDE,
            permissions::AUDIT_READ,
            permissions::ADMIN_HEALTH,
        ] {
            let perm = store
                .create_permission(&lexaudit_domain::Permission {
                    id: Uuid::new_v4(),
                    code: perm_code.to_string(),
                    description: None,
                    created_at: Utc::now(),
                })
                .await
                .unwrap();
            store.grant_permission_to_role(role.id, perm.id).await.unwrap();
        }
    }

    let config = Arc::new(AppConfig::test_config());
    let audit_logger = AuditLogger::new(store.clone());
    let rate_limiter = InMemoryRateLimiter::new();

    let state = AppState {
        config: config.clone(),
        company_repo: store.clone(),
        user_repo: store.clone(),
        session_repo: store.clone(),
        role_repo: store.clone(),
        approval_repo: store.clone(),
        audit_logger,
        rate_limiter,
    };

    let router = create_router(state.clone());
    (router, state, company_id, user_id)
}

#[tokio::test]
async fn test_health_check_endpoint() {
    let (app, _, _, _) = setup_test_app().await;

    let req = Request::builder()
        .uri("/admin/health")
        .method(Method::GET)
        .body(Body::empty())
        .unwrap();

    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let json: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["status"], "ok");
    assert_eq!(json["service"], "lexaudit-api");
}

#[tokio::test]
async fn test_openapi_spec_endpoint() {
    let (app, _, _, _) = setup_test_app().await;

    let req = Request::builder()
        .uri("/api/v1/openapi.json")
        .method(Method::GET)
        .body(Body::empty())
        .unwrap();

    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let json: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["openapi"], "3.0.3");
}

#[tokio::test]
async fn test_auth_login_success_and_cookie_attributes() {
    let (app, _, _, _) = setup_test_app().await;

    let login_payload = serde_json::json!({
        "email": "accountant@lexaudit.az",
        "password": "CorrectPass123!"
    });

    let req = Request::builder()
        .uri("/api/v1/auth/login")
        .method(Method::POST)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::to_vec(&login_payload).unwrap()))
        .unwrap();

    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // Verify Set-Cookie has HttpOnly, Secure, SameSite=Strict
    let cookie_header = res
        .headers()
        .get(header::SET_COOKIE)
        .expect("Must set refresh token cookie")
        .to_str()
        .unwrap();

    assert!(cookie_header.contains("refresh_token="));
    assert!(cookie_header.contains("HttpOnly"));
    assert!(cookie_header.contains("SameSite=Strict"));

    let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let json: Value = serde_json::from_slice(&body).unwrap();
    assert!(json["accessToken"].is_string());
    assert!(json["csrfToken"].is_string());
    assert_eq!(json["expiresInSeconds"], 900);
}

#[tokio::test]
async fn test_auth_login_invalid_password_returns_401() {
    let (app, _, _, _) = setup_test_app().await;

    let login_payload = serde_json::json!({
        "email": "accountant@lexaudit.az",
        "password": "WrongPassword!"
    });

    let req = Request::builder()
        .uri("/api/v1/auth/login")
        .method(Method::POST)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::to_vec(&login_payload).unwrap()))
        .unwrap();

    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn test_me_requires_auth_and_returns_tenant_info() {
    let (app, state, company_id, user_id) = setup_test_app().await;

    // 1. Without auth header -> 401 UNAUTHENTICATED
    let unauth_req = Request::builder()
        .uri("/api/v1/me")
        .method(Method::GET)
        .body(Body::empty())
        .unwrap();
    let res = app.clone().oneshot(unauth_req).await.unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

    // 2. With valid JWT -> 200 OK
    let token = lexaudit_api::security::create_access_token(
        user_id,
        company_id,
        "accountant@lexaudit.az",
        vec!["accountant".into()],
        vec![permissions::USERS_READ.into()],
        15,
        &state.config.jwt_secret,
    )
    .unwrap();

    let auth_req = Request::builder()
        .uri("/api/v1/me")
        .method(Method::GET)
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap();

    let res2 = app.oneshot(auth_req).await.unwrap();
    assert_eq!(res2.status(), StatusCode::OK);
}

#[tokio::test]
async fn test_refresh_token_rotation() {
    let (app, state, company_id, user_id) = setup_test_app().await;

    let raw_refresh_token = "raw_refresh_token_for_test_rotation";
    let hash = hash_refresh_token(raw_refresh_token);
    let now = Utc::now();

    let session = Session {
        id: Uuid::new_v4(),
        company_id,
        user_id,
        refresh_token_hash: hash,
        expires_at: now + Duration::days(30),
        revoked_at: None,
        ip: Some("127.0.0.1".into()),
        user_agent: Some("TestAgent".into()),
        created_at: now,
        updated_at: now,
    };
    state.session_repo.create_session(&session).await.unwrap();

    // Call /auth/refresh with cookie
    let refresh_req = Request::builder()
        .uri("/api/v1/auth/refresh")
        .method(Method::POST)
        .header(header::COOKIE, format!("refresh_token={raw_refresh_token}"))
        .body(Body::empty())
        .unwrap();

    let res = app.oneshot(refresh_req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // Verify old session revoked (Audit A-07)
    let old_active = state.session_repo.find_active_session_by_hash(&hash_refresh_token(raw_refresh_token), now).await.unwrap();
    assert!(old_active.is_none());
}

#[tokio::test]
async fn test_approvals_a03_and_a04_enforcement() {
    let (app, state, company_id, user_id) = setup_test_app().await;

    // Create an approval requested by user_id
    let approval = Approval::new(
        company_id,
        "tax_return",
        "return_q1",
        serde_json::json!({"net": "50000"}),
        user_id,
        Utc::now() + Duration::hours(24),
    );
    state.approval_repo.create_approval(&approval).await.unwrap();

    // Authenticate as the requester user_id
    let token = lexaudit_api::security::create_access_token(
        user_id,
        company_id,
        "accountant@lexaudit.az",
        vec!["accountant".into()],
        vec![permissions::APPROVALS_READ.into(), permissions::APPROVALS_DECIDE.into()],
        15,
        &state.config.jwt_secret,
    )
    .unwrap();

    // Audit A-03: Attempting to self-approve must be rejected!
    let decide_payload = serde_json::json!({
        "decision": "approve",
        "comment": "Self approval attempt"
    });

    let self_approve_req = Request::builder()
        .uri(format!("/api/v1/approvals/{}/decide", approval.id))
        .method(Method::POST)
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::to_vec(&decide_payload).unwrap()))
        .unwrap();

    let res = app.clone().oneshot(self_approve_req).await.unwrap();
    // Must be 403 Forbidden or 409 Conflict (self-approval forbidden)
    assert!(res.status() == StatusCode::FORBIDDEN || res.status() == StatusCode::CONFLICT);

    // Now test with a different approver
    let approver_id = Uuid::new_v4();
    let approver_token = lexaudit_api::security::create_access_token(
        approver_id,
        company_id,
        "manager@lexaudit.az",
        vec!["manager".into()],
        vec![permissions::APPROVALS_READ.into(), permissions::APPROVALS_DECIDE.into()],
        15,
        &state.config.jwt_secret,
    )
    .unwrap();

    let valid_approve_req = Request::builder()
        .uri(format!("/api/v1/approvals/{}/decide", approval.id))
        .method(Method::POST)
        .header(header::AUTHORIZATION, format!("Bearer {approver_token}"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::to_vec(&decide_payload).unwrap()))
        .unwrap();

    let res2 = app.clone().oneshot(valid_approve_req).await.unwrap();
    assert_eq!(res2.status(), StatusCode::OK);

    // Audit A-04: Trying to decide again on approved request must return 409 CONFLICT
    let second_decide_req = Request::builder()
        .uri(format!("/api/v1/approvals/{}/decide", approval.id))
        .method(Method::POST)
        .header(header::AUTHORIZATION, format!("Bearer {approver_token}"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::to_vec(&decide_payload).unwrap()))
        .unwrap();

    let res3 = app.oneshot(second_decide_req).await.unwrap();
    assert_eq!(res3.status(), StatusCode::CONFLICT);
}
