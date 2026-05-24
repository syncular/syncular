/// Deterministic id generator for tests that need stable row ids, commit ids,
/// or command ids.
#[derive(Debug, Clone)]
pub struct DeterministicIds {
    prefix: String,
    next: u64,
}

impl DeterministicIds {
    pub fn new(prefix: impl Into<String>) -> Self {
        Self {
            prefix: prefix.into(),
            next: 0,
        }
    }

    pub fn next_id(&mut self) -> String {
        self.next = self.next.saturating_add(1);
        format!("{}-{}", self.prefix, self.next)
    }
}

/// Fake millisecond clock with explicit advancement.
#[derive(Debug, Clone)]
pub struct FakeClock {
    now_ms: i64,
}

impl FakeClock {
    pub fn new(now_ms: i64) -> Self {
        Self { now_ms }
    }

    pub fn now_ms(&self) -> i64 {
        self.now_ms
    }

    pub fn advance_ms(&mut self, delta_ms: i64) -> i64 {
        self.now_ms = self.now_ms.saturating_add(delta_ms);
        self.now_ms
    }
}

impl Default for FakeClock {
    fn default() -> Self {
        Self::new(1_700_000_000_000)
    }
}
