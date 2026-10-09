use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;

use crate::error::ApiError;

/// Hashes password using Argon2id.
pub fn hash_password(password: &str) -> Result<String, ApiError> {
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default();
    let hash = argon2
        .hash_password(password.as_bytes(), &salt)
        .map_err(|e| ApiError::Internal(format!("Failed to hash password: {e}")))?;
    Ok(hash.to_string())
}

/// Verifies plaintext password against Argon2id hash.
pub fn verify_password(password: &str, password_hash: &str) -> Result<bool, ApiError> {
    let parsed_hash = PasswordHash::new(password_hash)
        .map_err(|e| ApiError::Internal(format!("Invalid password hash format: {e}")))?;
    Ok(Argon2::default()
        .verify_password(password.as_bytes(), &parsed_hash)
        .is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_argon2_hash_and_verify() {
        let pass = "SecretPass123!@#";
        let hash = hash_password(pass).unwrap();
        assert!(verify_password(pass, &hash).unwrap());
        assert!(!verify_password("wrong-pass", &hash).unwrap());
    }
}
