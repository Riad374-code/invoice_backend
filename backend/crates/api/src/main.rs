use std::sync::Arc;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use lexaudit_api::config::AppConfig;
use lexaudit_api::middleware::InMemoryRateLimiter;
use lexaudit_api::router::create_router;
use lexaudit_api::state::AppState;
use lexaudit_audit::AuditLogger;
use lexaudit_db::{InMemoryStore, PgDb};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // 1. Initialize tracing subscriber
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,lexaudit=debug".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    tracing::info!("Starting LexAudit AI Backend Server...");

    // 2. Load and validate strongly-typed configuration (§3 & B01: missing secret -> start olmur)
    let config = match AppConfig::from_env() {
        Ok(cfg) => Arc::new(cfg),
        Err(err) => {
            tracing::error!("Configuration failure (missing secret): {err}");
            eprintln!("CRITICAL CONFIGURATION ERROR: {err}");
            std::process::exit(1);
        }
    };

    tracing::info!(
        app_env = %config.app_env,
        bind_addr = %config.bind_addr,
        "Configuration successfully validated"
    );

    // 3. Connect to database or initialize development in-memory store
    let (company_repo, user_repo, session_repo, role_repo, approval_repo, audit_logger) = {
        tracing::info!(db_url = %config.database_url, "Connecting to PostgreSQL database...");
        match PgDb::connect(&config.database_url).await {
            Ok(pg) => {
                tracing::info!("Connected to PostgreSQL database successfully");
                let pg_arc = Arc::new(pg);
                let logger = AuditLogger::new(pg_arc.clone());
                (
                    pg_arc.clone() as Arc<dyn lexaudit_db::CompanyRepository>,
                    pg_arc.clone() as Arc<dyn lexaudit_db::UserRepository>,
                    pg_arc.clone() as Arc<dyn lexaudit_db::SessionRepository>,
                    pg_arc.clone() as Arc<dyn lexaudit_db::RoleRepository>,
                    pg_arc.clone() as Arc<dyn lexaudit_db::ApprovalRepository>,
                    logger,
                )
            }
            Err(e) => {
                tracing::warn!(
                    "Failed to connect to PostgreSQL ({}). Initializing in-memory dev store...",
                    e
                );
                let mem = Arc::new(InMemoryStore::new());
                mem.seed_defaults().await?;
                let logger = AuditLogger::new(mem.clone());
                (
                    mem.clone() as Arc<dyn lexaudit_db::CompanyRepository>,
                    mem.clone() as Arc<dyn lexaudit_db::UserRepository>,
                    mem.clone() as Arc<dyn lexaudit_db::SessionRepository>,
                    mem.clone() as Arc<dyn lexaudit_db::RoleRepository>,
                    mem.clone() as Arc<dyn lexaudit_db::ApprovalRepository>,
                    logger,
                )
            }
        }
    };

    let rate_limiter = InMemoryRateLimiter::new();

    let state = AppState {
        config: config.clone(),
        company_repo,
        user_repo,
        session_repo,
        role_repo,
        approval_repo,
        audit_logger,
        rate_limiter,
    };

    // 4. Build Axum Router
    let app = create_router(state);

    // 5. Bind listener and start server
    let listener = tokio::net::TcpListener::bind(config.bind_addr).await?;
    tracing::info!("LexAudit AI backend listening on http://{}", config.bind_addr);
    tracing::info!("Health endpoint available at http://{}/admin/health", config.bind_addr);
    tracing::info!("OpenAPI spec available at http://{}/api/v1/openapi.json", config.bind_addr);

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    tracing::info!("Server shut down gracefully");
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("Failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("Failed to install signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {
            tracing::info!("Received Ctrl+C, initiating shutdown...");
        },
        _ = terminate => {
            tracing::info!("Received termination signal, initiating shutdown...");
        },
    }
}
