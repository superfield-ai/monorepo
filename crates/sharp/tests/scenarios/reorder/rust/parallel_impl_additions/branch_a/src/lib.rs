pub struct Counter(u64);

impl Counter {
    pub fn new() -> Self {
        Counter(0)
    }

    pub fn increment(&mut self) {
        self.0 += 1;
    }
}

impl Default for Counter {
    fn default() -> Self {
        Self::new()
    }
}
