use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;

static VOEN_REGEX: Lazy<Regex> = Lazy::new(|| {
    // 10 digits
    Regex::new(r"\b(\d{4})\d{4}(\d{2})\b").unwrap()
});

static AZ_IBAN_REGEX: Lazy<Regex> = Lazy::new(|| {
    // Azerbaijan IBAN: AZ + 2 check digits + 4 char bank code + 20 digits account = 28 characters
    Regex::new(r"\b(AZ\d{2}[A-Z0-9]{4})[A-Z0-9]{16}([A-Z0-9]{4})\b").unwrap()
});

static PHONE_REGEX: Lazy<Regex> = Lazy::new(|| {
    // Azerbaijani phone formats: +994(50/51/55/70/77/10/99) or 0(50/51/55/70/77/10/99)
    Regex::new(r"(?:\+994[\s\-]?0?|0)(50|51|55|70|77|10|99)[\s\-]?(\d{3})[\s\-]?(\d{2})[\s\-]?(\d{2})").unwrap()
});

/// Mask sensitive Azerbaijani identifiers in plain text:
/// - VÖEN (10 digits) -> `1234****90`
/// - AZ IBAN (28 chars) -> `AZ21NABZ****************0106`
/// - Phone -> masked
pub fn mask_text(input: &str) -> String {
    let mut masked = input.to_string();

    // Mask IBAN first (longer)
    masked = AZ_IBAN_REGEX
        .replace_all(&masked, |caps: &regex::Captures| {
            format!("{}****************{}", &caps[1], &caps[2])
        })
        .to_string();

    // Mask Phone numbers first (specifically with country/operator codes)
    masked = PHONE_REGEX
        .replace_all(&masked, |caps: &regex::Captures| {
            let operator = &caps[1];
            let end = &caps[4];
            format!("(0{})***-**-{}", operator, end)
        })
        .to_string();

    // Mask VÖEN (10 digits)
    masked = VOEN_REGEX
        .replace_all(&masked, |caps: &regex::Captures| {
            format!("{}****{}", &caps[1], &caps[2])
        })
        .to_string();

    masked
}

/// Recursively masks PII in JSON objects and values.
pub fn mask_json_value(value: &Value) -> Value {
    match value {
        Value::String(s) => Value::String(mask_text(s)),
        Value::Array(arr) => Value::Array(arr.iter().map(mask_json_value).collect()),
        Value::Object(map) => {
            let mut new_map = serde_json::Map::new();
            for (k, v) in map {
                // If key is explicitly sensitive (e.g. fin, password, secret, voen, iban, phone)
                let lower_k = k.to_lowercase();
                if lower_k.contains("password") || lower_k.contains("secret") || lower_k.contains("token") {
                    new_map.insert(k.clone(), Value::String("[REDACTED]".to_string()));
                } else if lower_k == "fin" {
                    if let Value::String(fin_val) = v {
                        if fin_val.len() == 7 {
                            let masked_fin = format!("{}***{}", &fin_val[..2], &fin_val[5..]);
                            new_map.insert(k.clone(), Value::String(masked_fin));
                        } else {
                            new_map.insert(k.clone(), Value::String("[MASKED_FIN]".to_string()));
                        }
                    } else {
                        new_map.insert(k.clone(), mask_json_value(v));
                    }
                } else {
                    new_map.insert(k.clone(), mask_json_value(v));
                }
            }
            Value::Object(new_map)
        }
        _ => value.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mask_voen() {
        let text = "Company VOEN is 1234567890 for taxpayer";
        let masked = mask_text(text);
        assert_eq!(masked, "Company VOEN is 1234****90 for taxpayer");
    }

    #[test]
    fn test_mask_az_iban() {
        let text = "Account: AZ21NABZ01350100000000000106 please transfer";
        let masked = mask_text(text);
        assert_eq!(masked, "Account: AZ21NABZ****************0106 please transfer");
    }

    #[test]
    fn test_mask_phone() {
        let text = "Call +994501234567 or 0559876543";
        let masked = mask_text(text);
        assert!(masked.contains("(050)***-**-67"));
        assert!(masked.contains("(055)***-**-43"));
    }

    #[test]
    fn test_mask_json_object() {
        let json_input = serde_json::json!({
            "company_name": "Test MMC",
            "voen": "1234567890",
            "fin": "12ABC78",
            "password": "super-secret-pass",
            "account": "AZ21NABZ01350100000000000106"
        });

        let masked = mask_json_value(&json_input);
        assert_eq!(masked["voen"], "1234****90");
        assert_eq!(masked["fin"], "12***78");
        assert_eq!(masked["password"], "[REDACTED]");
        assert_eq!(masked["account"], "AZ21NABZ****************0106");
    }
}
