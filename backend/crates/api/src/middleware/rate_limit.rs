use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::Mutex;

#[derive(Clone, Default)]
pub struct InMemoryRateLimiter {
    // Key -> (Count, WindowStartTime)
    buckets: Arc<Mutex<HashMap<String, (u32, Instant)>>>,
}

impl InMemoryRateLimiter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Checks if a request for `key` is allowed within window_secs with max_requests.
    pub async fn check(&self, key: &str, max_requests: u32, window_secs: u64) -> bool {
        let mut buckets = self.buckets.lock().await;
        let now = Instant::now();
        let window_duration = std::time::Duration::from_secs(window_secs);

        if let Some((count, start_time)) = buckets.get_mut(key) {
            if now.duration_since(*start_time) < window_duration {
                if *count >= max_requests {
                    return false;
                }
                *count += 1;
                return true;
            } else {
                *count = 1;
                *start_time = now;
                return true;
            }
        }

        buckets.insert(key.to_string(), (1, now));
        true
    }
}
