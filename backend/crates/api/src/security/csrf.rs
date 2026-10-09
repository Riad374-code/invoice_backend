use rand::RngCore;
use sha2::{Digest, Sha256};

pub fn generate_csrf_token(secret: &str) -> String {
    let mut nonce = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut nonce);
    let nonce_hex = hex_encode(&nonce);

    let mut hasher = Sha256::new();
    hasher.update(secret.as_bytes());
    hasher.update(nonce_hex.as_bytes());
    let sig = hex_encode(hasher.finalize());

    format!("{nonce_hex}.{sig}")
}

pub fn verify_csrf_token(token: &str, secret: &str) -> bool {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 2 {
        return false;
    }
    let nonce_hex = parts[0];
    let signature = parts[1];

    let mut hasher = Sha256::new();
    hasher.update(secret.as_bytes());
    hasher.update(nonce_hex.as_bytes());
    let expected_sig = hex_encode(hasher.finalize());

    signature == expected_sig
}

fn hex_encode(data: impl AsRef<[u8]>) -> String {
    let mut s = String::with_capacity(data.as_ref().len() * 2);
    for &b in data.as_ref() {
        use std::fmt::Write;
        let _ = write!(s, "{:02x}", b);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_csrf_generation_and_verification() {
        let secret = "my-secure-csrf-secret";
        let token = generate_csrf_token(secret);
        assert!(verify_csrf_token(&token, secret));
        assert!(!verify_csrf_token(&token, "wrong-secret"));
        assert!(!verify_csrf_token("invalid.token", secret));
    }
}
