//! LexAudit AI — Immutable Audit Log Writer with PII Masking
//! §4.1: audit_events — yalnız INSERT (UPDATE/DELETE DB səviyyəsində qadağan)
//! §11: PII maskalama log-larda (VÖEN, FİN, IBAN, telefon)

pub mod pii;
pub mod writer;

pub use pii::{mask_json_value, mask_text};
pub use writer::AuditLogger;

#[cfg(test)]
mod tests {
    use super::*;
    use lexaudit_db::InMemoryStore;
    use std::sync::Arc;
    use uuid::Uuid;

    #[tokio::test]
    async fn test_audit_logger_masks_pii_on_insert() {
        let store = Arc::new(InMemoryStore::new());
        let logger = AuditLogger::new(store.clone());

        let cid = Uuid::new_v4();
        let actor_id = Some(Uuid::new_v4());
        let before = serde_json::json!({
            "client_voen": "9988776655",
            "fin": "7XYZ999",
            "notes": "Transfer to AZ21NABZ01350100000000000106"
        });

        let event = logger
            .log(
                cid,
                actor_id,
                "client.update",
                "client",
                "c-01",
                Some(before),
                None,
                "req_test_1",
            )
            .await
            .unwrap();

        assert_eq!(event.company_id, cid);
        let recorded_before = event.before.unwrap();
        assert_eq!(recorded_before["client_voen"], "9988****55");
        assert_eq!(recorded_before["fin"], "7X***99");
        assert!(recorded_before["notes"].as_str().unwrap().contains("AZ21NABZ****************0106"));
    }
}
