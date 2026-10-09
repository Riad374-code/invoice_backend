use axum::middleware as axum_mw;
use axum::routing::{get, post};
use axum::Router;
use tower_http::trace::TraceLayer;

use crate::middleware::{build_cors_layer, request_id_middleware};
use crate::openapi::openapi_spec_handler;
use crate::routes::{admin, approvals, audit, auth, stubs};
use crate::state::AppState;

pub fn create_router(state: AppState) -> Router {
    let api_v1 = Router::new()
        // Auth endpoints
        .route("/auth/login", post(auth::login_handler))
        .route("/auth/refresh", post(auth::refresh_handler))
        .route("/auth/logout", post(auth::logout_handler))
        .route("/me", get(auth::me_handler))
        // Admin & Health
        .route("/admin/health", get(admin::health_handler))
        .route("/admin/users", get(admin::admin_users_handler))
        .route("/admin/roles", get(admin::admin_roles_handler))
        .route("/admin/sources", get(admin::admin_sources_handler))
        .route("/admin/tax-rates", get(admin::admin_tax_rates_handler))
        .route("/admin/models", get(admin::admin_models_handler))
        // Approvals
        .route(
            "/approvals",
            get(approvals::list_approvals_handler),
        )
        .route(
            "/approvals/:id/decide",
            post(approvals::decide_approval_handler),
        )
        // Audit
        .route("/audit-events", get(audit::list_audit_events_handler))
        // Stubs for upcoming stages
        .route("/invoices", get(stubs::list_invoices_handler))
        .route("/vat/periods", get(stubs::list_vat_periods_handler))
        .route("/journal", get(stubs::list_journal_handler))
        .route("/excel/jobs", post(stubs::excel_jobs_handler))
        .route("/reconciliations", post(stubs::reconciliations_handler))
        .route("/news", get(stubs::news_handler))
        .route("/legislation", get(stubs::legislation_handler))
        .route("/files", get(stubs::files_handler))
        .route("/assistant", post(stubs::assistant_handler))
        // OpenAPI specification
        .route("/openapi.json", get(openapi_spec_handler));

    Router::new()
        // Root health check endpoint
        .route("/admin/health", get(admin::health_handler))
        .nest("/api/v1", api_v1)
        .layer(build_cors_layer(&state.config.cors_allowed_origins))
        .layer(axum_mw::from_fn(request_id_middleware))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
