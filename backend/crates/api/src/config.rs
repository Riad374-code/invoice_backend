use std::net::SocketAddr;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("Missing required environment secret: {0}. Server refusing to start.")]
    MissingSecret(String),

    #[error("Invalid configuration value for {key}: {reason}")]
    InvalidValue { key: String, reason: String },

    #[error("Configuration parse error: {0}")]
    Parse(String),
}

#[derive(Debug, Clone)]
pub struct AppConfig {
    pub app_env: String,
    pub bind_addr: SocketAddr,
    pub public_base_url: String,
    pub cors_allowed_origins: Vec<String>,
    pub database_url: String,
    pub jwt_secret: String,
    pub access_token_ttl_minutes: i64,
    pub refresh_token_ttl_days: i64,
    pub csrf_secret: String,
    pub s3_endpoint: Option<String>,
    pub s3_region: Option<String>,
    pub s3_bucket: Option<String>,
    pub s3_access_key: Option<String>,
    pub s3_secret_key: Option<String>,
    pub model_serving_base_url: Option<String>,
}

impl AppConfig {
    /// Loads configuration strictly from environment variables.
    /// In accordance with §3: "typed config, eksik secret → start olmur"
    pub fn from_env() -> Result<Self, ConfigError> {
        let app_env = std::env::var("APP_ENV").unwrap_or_else(|_| "development".to_string());

        let bind_addr_str = std::env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".to_string());
        let bind_addr: SocketAddr = bind_addr_str.parse().map_err(|e| ConfigError::InvalidValue {
            key: "BIND_ADDR".to_string(),
            reason: format!("{e}"),
        })?;

        let public_base_url = std::env::var("PUBLIC_BASE_URL")
            .unwrap_or_else(|_| "http://localhost:8080".to_string());

        let cors_str = std::env::var("CORS_ALLOWED_ORIGINS").unwrap_or_else(|_| "http://localhost:3000".to_string());
        let cors_allowed_origins: Vec<String> = cors_str
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

        if cors_allowed_origins.is_empty() {
            return Err(ConfigError::InvalidValue {
                key: "CORS_ALLOWED_ORIGINS".to_string(),
                reason: "At least one allowed CORS origin must be configured".to_string(),
            });
        }

        let database_url = std::env::var("DATABASE_URL").unwrap_or_else(|_| {
            "postgres://lexaudit:lexaudit_dev@localhost:5432/lexaudit".to_string()
        });

        // Strict secret checks
        let jwt_secret = std::env::var("JWT_SECRET").map_err(|_| {
            ConfigError::MissingSecret("JWT_SECRET (must be configured via env/secret manager)".to_string())
        })?;

        if jwt_secret.trim().is_empty() || jwt_secret.len() < 16 {
            return Err(ConfigError::InvalidValue {
                key: "JWT_SECRET".to_string(),
                reason: "Secret must be at least 16 characters (recommended 32+ bytes)".to_string(),
            });
        }

        let access_token_ttl_minutes: i64 = std::env::var("ACCESS_TOKEN_TTL_MINUTES")
            .unwrap_or_else(|_| "15".to_string())
            .parse()
            .map_err(|_| ConfigError::InvalidValue {
                key: "ACCESS_TOKEN_TTL_MINUTES".to_string(),
                reason: "Must be a valid integer".to_string(),
            })?;

        let refresh_token_ttl_days: i64 = std::env::var("REFRESH_TOKEN_TTL_DAYS")
            .unwrap_or_else(|_| "30".to_string())
            .parse()
            .map_err(|_| ConfigError::InvalidValue {
                key: "REFRESH_TOKEN_TTL_DAYS".to_string(),
                reason: "Must be a valid integer".to_string(),
            })?;

        let csrf_secret = std::env::var("CSRF_SECRET").map_err(|_| {
            ConfigError::MissingSecret("CSRF_SECRET (must be configured via env/secret manager)".to_string())
        })?;

        if csrf_secret.trim().is_empty() || csrf_secret.len() < 16 {
            return Err(ConfigError::InvalidValue {
                key: "CSRF_SECRET".to_string(),
                reason: "CSRF secret must be at least 16 characters".to_string(),
            });
        }

        let s3_endpoint = std::env::var("S3_ENDPOINT").ok();
        let s3_region = std::env::var("S3_REGION").ok();
        let s3_bucket = std::env::var("S3_BUCKET").ok();
        let s3_access_key = std::env::var("S3_ACCESS_KEY").ok();
        let s3_secret_key = std::env::var("S3_SECRET_KEY").ok();
        let model_serving_base_url = std::env::var("MODEL_SERVING_BASE_URL").ok();

        Ok(Self {
            app_env,
            bind_addr,
            public_base_url,
            cors_allowed_origins,
            database_url,
            jwt_secret,
            access_token_ttl_minutes,
            refresh_token_ttl_days,
            csrf_secret,
            s3_endpoint,
            s3_region,
            s3_bucket,
            s3_access_key,
            s3_secret_key,
            model_serving_base_url,
        })
    }

    /// Helper for unit tests with dummy credentials.
    pub fn test_config() -> Self {
        Self {
            app_env: "test".to_string(),
            bind_addr: "127.0.0.1:8080".parse().unwrap(),
            public_base_url: "http://localhost:8080".to_string(),
            cors_allowed_origins: vec!["http://localhost:3000".to_string()],
            database_url: "postgres://localhost/test".to_string(),
            jwt_secret: "test-secret-at-least-32-bytes-long-for-jwt-token".to_string(),
            access_token_ttl_minutes: 15,
            refresh_token_ttl_days: 30,
            csrf_secret: "test-csrf-secret-16-bytes".to_string(),
            s3_endpoint: None,
            s3_region: None,
            s3_bucket: None,
            s3_access_key: None,
            s3_secret_key: None,
            model_serving_base_url: None,
        }
    }
}
