//! LexAudit AI backend — Axum server (B1+B3).
//! Single source of truth: never trusts numbers or permissions computed by the LLM.

pub mod config;
pub mod error;
pub mod middleware;
pub mod openapi;
pub mod router;
pub mod routes;
pub mod security;
pub mod state;

pub use config::AppConfig;
pub use error::ApiError;
pub use router::create_router;
pub use state::AppState;
