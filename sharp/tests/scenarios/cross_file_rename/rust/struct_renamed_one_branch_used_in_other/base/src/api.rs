pub struct HttpClient;

impl HttpClient {
    pub fn fetch(&self, _url: &str) -> &'static str {
        "response"
    }
}
