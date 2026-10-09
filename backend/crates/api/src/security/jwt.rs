use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::error::ApiError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    pub sub: Uuid,
    pub company_id: Uuid,
    pub email: String,
    pub roles: Vec<String>,
    pub permissions: Vec<String>,
    pub exp: usize,
    pub iat: usize,
}

/// Creates a signed JWT access token valid for the specified minutes.
pub fn create_access_token(
    user_id: Uuid,
    company_id: Uuid,
    email: &str,
    roles: Vec<String>,
    permissions: Vec<String>,
    ttl_minutes: i64,
    secret: &str,
) -> Result<String, ApiError> {
    let now = Utc::now();
    let exp = now + Duration::minutes(ttl_minutes);

    let claims = Claims {
        sub: user_id,
        company_id,
        email: email.to_string(),
        roles,
        permissions,
        exp: exp.timestamp() as usize,
        iat: now.timestamp() as usize,
    };

    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| ApiError::Internal(format!("Failed to sign JWT access token: {e}")))
}

/// Verifies and decodes a JWT access token.
pub fn verify_access_token(token: &str, secret: &str) -> Result<Claims, ApiError> {
    let validation = Validation::default();
    let token_data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .map_err(|e| ApiError::Unauthenticated(format!("Invalid or expired access token: {e}")))?;

    Ok(token_data.claims)
}

/// Generates a cryptographically strong random refresh token string.
pub fn generate_refresh_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

/// Calculates the SHA-256 hash of a refresh token to store in the DB `sessions` table.
pub fn hash_refresh_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hex::encode(hasher.finalize())
}

// Minimal hex encoder for standard use without requiring external hex crate
mod hex {
    pub fn encode(data: impl AsRef<[u8]>) -> String {
        let mut s = String::with_capacity(data.as_ref().len() * 2);
        for &b in data.as_ref() {
            use std::fmt::Write;
            let _ = write!(s, "{:02x}", b);
        }
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_jwt_create_and_verify() {
        let secret = "very-secure-jwt-secret-with-minimum-32-bytes";
        let uid = Uuid::new_v4();
        let cid = Uuid::new_v4();
        let token = create_access_token(
            uid,
            cid,
            "test@lexaudit.az",
            vec!["admin".into()],
            vec!["invoices:read".into()],
            15,
            secret,
        )
        .unwrap();

        let claims = verify_access_token(&token, secret).unwrap();
        assert_eq!(claims.sub, uid);
        assert_eq!(claims.company_id, cid);
        assert_eq!(claims.email, "test@lexaudit.az");
        assert!(claims.permissions.contains(&"invoices:read".to_string()));
    }

    #[test]
    fn test_refresh_token_hashing() {
        let token = generate_refresh_token();
        let hash1 = hash_refresh_token(&token);
        let hash2 = hash_refresh_token(&token);
        assert_eq!(hash1, hash2);
        assert_ne!(token, hash1);
    }
}
