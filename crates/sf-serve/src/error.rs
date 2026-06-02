//! Top-level error type for the `sf-serve` crate.

use std::net::SocketAddr;
use thiserror::Error;

/// Errors returned by the serving layer.
#[derive(Debug, Error)]
pub enum ServeError {
    /// The TCP listener could not be bound to the requested address.
    #[error("failed to bind to {0}: {1}")]
    Bind(SocketAddr, std::io::Error),

    /// The axum server returned an error while running.
    #[error("server error: {0}")]
    Serve(std::io::Error),
}
