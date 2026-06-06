pub struct User {
    pub name: String,
}

impl User {
    pub fn new(name: &str) -> Self {
        User { name: name.to_string() }
    }

    pub fn greeting(&self) -> String {
        format!("Hello, {}!", self.name)
    }
}
