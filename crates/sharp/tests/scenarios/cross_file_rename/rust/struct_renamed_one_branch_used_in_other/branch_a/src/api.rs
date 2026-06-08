pub struct RestClient;

impl RestClient {
    pub fn fetch(&self, _url: &str) -> &'static str {
        "response"
    }
}
