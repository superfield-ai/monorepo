// Branch B introduced this module with a fresh use of the OLD struct name.
use crate::api::HttpClient;

pub fn make_client() -> HttpClient {
    HttpClient
}
