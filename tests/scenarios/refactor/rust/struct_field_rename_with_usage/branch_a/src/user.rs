pub struct User {
    pub label: String,
}

impl User {
    pub fn new(label: &str) -> Self {
        User { label: label.to_string() }
    }

    pub fn greeting(&self) -> String {
        format!("Hello, {}!", self.label)
    }
}
