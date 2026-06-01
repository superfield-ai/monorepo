//! OIDC / SAML federation seam.
//!
//! This module defines the [`IdentityProvider`] trait — the single interface
//! the rest of the codebase depends on when federating authentication to an
//! external identity provider.  No specific IdP (Okta, Auth0, Google, ADFS,
//! etc.) is implemented here; that is explicitly out of scope.
//!
//! An IdP implementation plugs in by:
//!
//! 1. Implementing [`IdentityProvider`].
//! 2. Passing a `Box<dyn IdentityProvider>` to [`crate::SessionStore::new`].
//!
//! The seam is async (`async_trait`-style manual boxing) so IdP
//! implementations can perform network calls (token introspection,
//! JWKS fetches) without blocking the executor.
//!
//! # Scope
//!
//! - **In scope:** the trait contract, the [`FederatedIdentity`] result type.
//! - **Out of scope:** any live OIDC/SAML wire implementation, UI login flows,
//!   token storage, key management.

use std::future::Future;
use std::pin::Pin;

use uuid::Uuid;

use crate::context::Role;

/// A verified identity returned by an external identity provider.
///
/// The IdP implementation is responsible for authenticating the raw credential
/// (e.g. an OIDC `id_token` or a SAML assertion) and mapping the result into
/// this type.  The auth crate then issues a session from the returned fields.
#[derive(Debug, Clone)]
pub struct FederatedIdentity {
    /// The user's stable unique identifier from the external IdP.
    ///
    /// Format is IdP-defined (e.g. `sub` claim in OIDC).  The auth crate
    /// treats this as an opaque string and maps it to its own `user_id` UUID.
    pub external_subject: String,

    /// The user's email address, used for display and workspace matching.
    pub email: String,

    /// Display name (may be empty if the IdP does not provide one).
    pub display_name: String,

    /// Workspace the IdP asserts this identity belongs to.
    ///
    /// When `None`, the auth crate places the user in a default workspace or
    /// rejects the login depending on tenant policy (policy is out of scope for
    /// this crate — callers handle it).
    pub workspace_id: Option<Uuid>,

    /// Role asserted by the IdP, if any.
    ///
    /// When `None`, the auth crate falls back to the default role configured
    /// for the workspace.
    pub role: Option<Role>,
}

/// Boxed, send-safe future alias used by the federation trait.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The federation seam: plug in any external identity provider here.
///
/// # Contract
///
/// - `verify` MUST authenticate the credential completely.  The auth crate
///   trusts the returned [`FederatedIdentity`] without re-verification.
/// - `verify` MUST be safe to call concurrently from multiple async tasks.
/// - Implementations SHOULD be cheap to clone (wrap state in `Arc` if needed).
///
/// # Example (sketch)
///
/// ```ignore
/// struct OidcProvider { jwks: Arc<JwkSet>, issuer: String }
///
/// impl IdentityProvider for OidcProvider {
///     fn verify<'a>(&'a self, credential: &'a str) -> BoxFuture<'a, Result<FederatedIdentity, ProviderError>> {
///         Box::pin(async move {
///             let claims = self.jwks.verify_jwt(credential, &self.issuer)?;
///             Ok(FederatedIdentity {
///                 external_subject: claims.sub,
///                 email: claims.email,
///                 display_name: claims.name.unwrap_or_default(),
///                 workspace_id: None,
///                 role: None,
///             })
///         })
///     }
/// }
/// ```
pub trait IdentityProvider: Send + Sync {
    /// Verify a raw credential (OIDC id_token, SAML assertion, opaque token)
    /// and return a verified [`FederatedIdentity`] or an error.
    ///
    /// The credential format is IdP-defined.  The auth crate does not inspect
    /// its contents — it passes it through to the provider unchanged.
    fn verify<'a>(
        &'a self,
        credential: &'a str,
    ) -> BoxFuture<'a, Result<FederatedIdentity, ProviderError>>;
}

/// Errors that an [`IdentityProvider`] implementation can return.
#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    /// The credential is structurally invalid (bad format, wrong encoding).
    #[error("invalid credential: {0}")]
    Invalid(String),

    /// The credential's signature or assertion could not be verified.
    #[error("verification failed: {0}")]
    VerificationFailed(String),

    /// The credential has expired.
    #[error("credential expired")]
    Expired,

    /// A transient error occurred while contacting the IdP (JWKS fetch, etc.).
    #[error("provider unreachable: {0}")]
    Unavailable(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Stub IdP that always succeeds — used to verify the trait is object-safe
    /// and callable in async contexts.
    struct StubIdp {
        identity: FederatedIdentity,
    }

    impl IdentityProvider for StubIdp {
        fn verify<'a>(
            &'a self,
            _credential: &'a str,
        ) -> BoxFuture<'a, Result<FederatedIdentity, ProviderError>> {
            let id = self.identity.clone();
            Box::pin(async move { Ok(id) })
        }
    }

    #[tokio::test]
    async fn stub_idp_returns_identity() {
        let idp = StubIdp {
            identity: FederatedIdentity {
                external_subject: "sub|abc123".to_string(),
                email: "alice@example.com".to_string(),
                display_name: "Alice".to_string(),
                workspace_id: None,
                role: Some(Role::Member),
            },
        };

        let result = idp.verify("dummy-token").await.unwrap();
        assert_eq!(result.email, "alice@example.com");
        assert_eq!(result.role, Some(Role::Member));
    }

    #[tokio::test]
    async fn stub_idp_trait_object_safe() {
        // Verify IdentityProvider can be used as a trait object.
        let idp: Box<dyn IdentityProvider> = Box::new(StubIdp {
            identity: FederatedIdentity {
                external_subject: "sub|xyz".to_string(),
                email: "bob@example.com".to_string(),
                display_name: "Bob".to_string(),
                workspace_id: Some(Uuid::new_v4()),
                role: None,
            },
        });
        let result = idp.verify("token").await.unwrap();
        assert_eq!(result.email, "bob@example.com");
    }
}
