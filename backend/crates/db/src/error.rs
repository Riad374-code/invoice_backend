use thiserror::Error;

#[derive(Debug, Error)]
pub enum DbError {
    #[error("Database error: {0}")]
    Sqlx(#[from] sqlx::Error),

    #[error("Record not found: {0}")]
    NotFound(String),

    #[error("Conflict / Unique constraint violation: {0}")]
    Conflict(String),

    #[error("Immutability violation: {0}")]
    ImmutabilityViolation(String),

    #[error("Constraint violation: {0}")]
    ConstraintViolation(String),

    #[error("Internal database lock/pool failure: {0}")]
    Internal(String),
}
