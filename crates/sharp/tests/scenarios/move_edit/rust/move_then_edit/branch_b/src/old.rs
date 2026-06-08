pub fn greet(name: &str, polite: bool) -> String {
    let lead = if polite { "good day" } else { "hello" };
    format!("{}, {}", lead, name)
}
