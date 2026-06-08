pub struct Counter(u64);

impl Counter {
    pub fn new() -> Self {
        Counter(0)
    }

    pub fn value(&self) -> u64 {
        self.0
    }
}

impl Default for Counter {
    fn default() -> Self {
        Self::new()
    }
}
