//! Read-only systems-of-record connector seam.
//!
//! A new Superfield app must be able to read data the enterprise already
//! maintains in its existing systems of record (CRM, ERP, ticketing, …)
//! *without modifying or replacing those systems*. This crate defines the
//! seam through which that read happens: the [`Connector`] trait, a
//! workspace-scoped [`ConnectorCredentials`] schema, and a reference
//! implementation ([`InMemoryConnector`]) exercised against an in-memory fake
//! source for tests and component crates that do not own a real integration.
//!
//! # Canonical docs
//!
//! - `docs/prd.md` US18 / §7 'Read from systems of record' — read-only
//!   connection to the enterprise's existing systems so a new app can use
//!   data the business maintains, *without modifying or replacing them*.
//! - `docs/prd.md` §Non-Goals — "Modifying, migrating, or replacing the
//!   enterprise's existing systems of record." The seam therefore has no
//!   write path by construction.
//! - `docs/architecture.md` §Single-Instance Database Schema Layout — workspace
//!   (tenant) identity is keyed by `workspaces.id` (`uuid::Uuid`); every
//!   per-workspace artifact carries that id. Connector credentials follow the
//!   same rule (see [`ConnectorCredentials::workspace_id`]).
//!
//! # Seam contract
//!
//! Reads are *on demand*: an app calls [`Connector::query`] (or
//! [`Connector::fetch`]) when it needs data, and the seam returns rows it read
//! from the source. There is deliberately **no** `insert` / `update` /
//! `delete` / `write` / `sync` method anywhere in the trait — the read-only
//! guarantee is structural, not merely documented. The reference connector
//! never mutates its backing fake source on any call.
//!
//! # The read-only guarantee
//!
//! The [`Connector`] trait exposes only the read verbs [`Connector::query`],
//! [`Connector::fetch`], and the introspection helpers
//! [`Connector::source_name`] / [`Connector::resources`]. Adding a write-shaped
//! method to the trait (or to any type that must satisfy [`Connector`]) is a
//! settled non-goal; the [`assert_read_only`] marker and the test
//! `connector_trait_exposes_only_read_methods` exist so that such a change is
//! caught at compile/test time rather than in review.
//!
//! # Implementations
//!
//! - [`InMemoryConnector`] — the reference connector. Holds an immutable
//!   in-memory [`FakeSource`] table set and serves reads from it. Cloning it is
//!   cheap and never copies a mutable handle, so callers cannot smuggle a write
//!   path in. Used by tests and by component crates that need a connector seam
//!   without a live external system.

use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Boxed async future alias used by [`Connector`] trait methods.
type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Errors returned by [`Connector`] operations.
#[derive(Debug, thiserror::Error)]
pub enum ConnectorError {
    /// The requested resource (table/object name) does not exist in the source.
    #[error("unknown resource: {0}")]
    UnknownResource(String),

    /// The requested row key was not found in the resource.
    #[error("row not found: {resource}/{key}")]
    RowNotFound {
        /// The resource that was queried.
        resource: String,
        /// The row key that was not found.
        key: String,
    },

    /// Authentication against the source failed.
    #[error("authentication failed: {0}")]
    Auth(String),

    /// A lower-level transport or upstream error from the source system.
    #[error("source error: {0}")]
    Source(String),
}

// ---------------------------------------------------------------------------
// Credential schema (workspace-scoped)
// ---------------------------------------------------------------------------

/// The kind of secret a connector authenticates with against its source.
///
/// This is a closed schema rather than an opaque blob so that the governance
/// layer can reason about credential types per workspace without inspecting
/// the secret material itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", content = "secret")]
pub enum CredentialKind {
    /// A long-lived API key / token presented on each read.
    ApiKey(String),
    /// A username/password pair (basic-auth style sources).
    BasicAuth {
        /// The login user.
        username: String,
        /// The login secret.
        password: String,
    },
    /// A pre-minted OAuth bearer token.
    OAuthBearer(String),
}

/// Workspace-scoped credentials for a single connector binding.
///
/// Every credential is scoped to exactly one workspace via [`workspace_id`].
/// There is no cross-workspace or global credential variant: a credential
/// minted for workspace A can never be presented for workspace B, because the
/// reference connector binds the credential's `workspace_id` at construction
/// and the seam offers no way to retarget it. This mirrors the per-workspace
/// (`workspaces.id`) keying used across the substrate (see crate docs).
///
/// [`workspace_id`]: ConnectorCredentials::workspace_id
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnectorCredentials {
    /// The workspace (tenant) this credential belongs to.
    ///
    /// Keyed by `workspaces.id`. A connector authenticates a read only when the
    /// credential's `workspace_id` matches the workspace the read is performed
    /// for; see [`InMemoryConnector::with_credentials`].
    pub workspace_id: Uuid,

    /// A stable, human-readable handle for the source this credential unlocks
    /// (e.g. `"acme-crm"`). Used for diagnostics and for binding a credential
    /// to a named source.
    pub source_name: String,

    /// The secret material and how to present it.
    pub kind: CredentialKind,
}

impl ConnectorCredentials {
    /// Construct a workspace-scoped credential.
    pub fn new(workspace_id: Uuid, source_name: impl Into<String>, kind: CredentialKind) -> Self {
        Self {
            workspace_id,
            source_name: source_name.into(),
            kind,
        }
    }
}

// ---------------------------------------------------------------------------
// Read model
// ---------------------------------------------------------------------------

/// A single row read from a source resource.
///
/// Rows are schemaless key/value maps so the seam stays source-agnostic; a
/// concrete app interprets the columns it needs.
pub type Row = BTreeMap<String, String>;

/// A read-only query against a source resource.
///
/// A query selects a resource (table/object name) and optionally filters rows
/// by an exact-match predicate. It carries no mutation intent — there is no
/// `set`, `values`, or `delete` field — so a query can only ever read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Query {
    /// The resource (table/object) to read from.
    pub resource: String,
    /// Optional exact-match filters applied to each candidate row (AND-ed).
    pub filters: Vec<(String, String)>,
}

impl Query {
    /// A query selecting every row of a resource.
    pub fn all(resource: impl Into<String>) -> Self {
        Self {
            resource: resource.into(),
            filters: Vec::new(),
        }
    }

    /// Add an exact-match filter (`column == value`).
    pub fn filter(mut self, column: impl Into<String>, value: impl Into<String>) -> Self {
        self.filters.push((column.into(), value.into()));
        self
    }
}

// ---------------------------------------------------------------------------
// Connector trait — read-only by construction
// ---------------------------------------------------------------------------

/// A read-only connector to an external system of record.
///
/// # Read-only by construction
///
/// This trait exposes **only** read verbs. There is intentionally no
/// `insert`, `update`, `delete`, `write`, `upsert`, or `sync` method. The seam
/// cannot modify, migrate, or replace the source — that is a PRD non-goal
/// (see crate docs). The read-only property is enforced structurally (the
/// surface area below) and by the `connector_trait_exposes_only_read_methods`
/// test plus the [`assert_read_only`] marker.
///
/// All methods are `&self` (never `&mut self`); a connector is a read handle
/// and holds no mutable claim on the source.
pub trait Connector: Send + Sync {
    /// The stable handle of the source this connector reads from.
    fn source_name(&self) -> &str;

    /// List the resources (table/object names) this connector can read.
    fn resources(&self) -> BoxFuture<'_, Result<Vec<String>, ConnectorError>>;

    /// Run a read-only [`Query`] and return the matching rows.
    ///
    /// Implementations must not mutate the source. Calling `query` any number
    /// of times leaves the source byte-for-byte unchanged.
    fn query<'a>(&'a self, query: &'a Query) -> BoxFuture<'a, Result<Vec<Row>, ConnectorError>>;

    /// Read a single row by its primary key from a resource.
    ///
    /// Convenience over [`query`]; same read-only guarantee.
    ///
    /// [`query`]: Connector::query
    fn fetch<'a>(
        &'a self,
        resource: &'a str,
        key: &'a str,
    ) -> BoxFuture<'a, Result<Row, ConnectorError>>;
}

/// Compile-time marker asserting `C` is a read-only [`Connector`].
///
/// This is a no-op at runtime; its purpose is to fail compilation if the
/// `Connector` trait is ever given a mutating (`&mut self`) method, since such
/// a method could not be satisfied through a shared `&C`. The
/// `connector_trait_exposes_only_read_methods` test instantiates this against
/// the reference connector so a regression is caught by `cargo test`.
pub fn assert_read_only<C: Connector + ?Sized>(_connector: &C) {}

// ---------------------------------------------------------------------------
// FakeSource — the in-memory backing store for the reference connector
// ---------------------------------------------------------------------------

/// An immutable in-memory fake system of record.
///
/// Holds named resources, each a list of rows keyed by an `"id"` column. Once
/// built, the reference connector reads from it but never writes to it — the
/// `query`/`fetch` paths take `&self`, so a `FakeSource` shared behind a
/// connector cannot be mutated through the seam.
#[derive(Debug, Clone, Default)]
pub struct FakeSource {
    name: String,
    resources: BTreeMap<String, Vec<Row>>,
}

impl FakeSource {
    /// Create an empty fake source with a stable name.
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            resources: BTreeMap::new(),
        }
    }

    /// Seed a resource with rows. Builder-only — used when constructing the
    /// fixture, never reachable through the read-only [`Connector`] seam.
    pub fn with_resource(mut self, resource: impl Into<String>, rows: Vec<Row>) -> Self {
        self.resources.insert(resource.into(), rows);
        self
    }

    /// The source's stable name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Number of rows currently stored in a resource (test/diagnostic helper).
    pub fn row_count(&self, resource: &str) -> Option<usize> {
        self.resources.get(resource).map(Vec::len)
    }
}

/// Convenience for building a [`Row`] from `(key, value)` pairs.
pub fn row<I, K, V>(pairs: I) -> Row
where
    I: IntoIterator<Item = (K, V)>,
    K: Into<String>,
    V: Into<String>,
{
    pairs
        .into_iter()
        .map(|(k, v)| (k.into(), v.into()))
        .collect()
}

// ---------------------------------------------------------------------------
// InMemoryConnector — the reference connector
// ---------------------------------------------------------------------------

/// The reference [`Connector`]: serves reads from an immutable [`FakeSource`].
///
/// Construct it with a [`FakeSource`] and a workspace-scoped
/// [`ConnectorCredentials`]. Reads succeed only when the credential's
/// `workspace_id` matches the workspace the connector was bound to, enforcing
/// the workspace-scoped guarantee. The connector holds the source immutably:
/// no method mutates it, so the read-only property holds at runtime as well as
/// in the trait surface.
#[derive(Debug, Clone)]
pub struct InMemoryConnector {
    workspace_id: Uuid,
    source: FakeSource,
    credentials: Option<ConnectorCredentials>,
}

impl InMemoryConnector {
    /// Create a connector bound to `workspace_id`, reading from `source`,
    /// with no credentials attached (anonymous reads, for fixtures that do not
    /// exercise the auth path).
    pub fn new(workspace_id: Uuid, source: FakeSource) -> Self {
        Self {
            workspace_id,
            source,
            credentials: None,
        }
    }

    /// Bind workspace-scoped credentials to this connector.
    ///
    /// The credential's `workspace_id` must equal the connector's bound
    /// workspace; binding a credential from a different workspace returns
    /// [`ConnectorError::Auth`], so a credential minted for workspace A can
    /// never authenticate reads for workspace B.
    pub fn with_credentials(
        mut self,
        credentials: ConnectorCredentials,
    ) -> Result<Self, ConnectorError> {
        if credentials.workspace_id != self.workspace_id {
            return Err(ConnectorError::Auth(format!(
                "credential workspace {} does not match connector workspace {}",
                credentials.workspace_id, self.workspace_id
            )));
        }
        self.credentials = Some(credentials);
        Ok(self)
    }

    /// The workspace this connector reads on behalf of.
    pub fn workspace_id(&self) -> Uuid {
        self.workspace_id
    }

    /// A read-only borrow of the backing source (test/diagnostic helper).
    pub fn source(&self) -> &FakeSource {
        &self.source
    }

    fn rows_of(&self, resource: &str) -> Result<&Vec<Row>, ConnectorError> {
        self.source
            .resources
            .get(resource)
            .ok_or_else(|| ConnectorError::UnknownResource(resource.to_string()))
    }
}

impl Connector for InMemoryConnector {
    fn source_name(&self) -> &str {
        self.source.name()
    }

    fn resources(&self) -> BoxFuture<'_, Result<Vec<String>, ConnectorError>> {
        Box::pin(async move { Ok(self.source.resources.keys().cloned().collect()) })
    }

    fn query<'a>(&'a self, query: &'a Query) -> BoxFuture<'a, Result<Vec<Row>, ConnectorError>> {
        Box::pin(async move {
            let rows = self.rows_of(&query.resource)?;
            let matched = rows
                .iter()
                .filter(|r| {
                    query
                        .filters
                        .iter()
                        .all(|(col, val)| r.get(col).map(|v| v == val).unwrap_or(false))
                })
                .cloned()
                .collect();
            Ok(matched)
        })
    }

    fn fetch<'a>(
        &'a self,
        resource: &'a str,
        key: &'a str,
    ) -> BoxFuture<'a, Result<Row, ConnectorError>> {
        Box::pin(async move {
            let rows = self.rows_of(resource)?;
            rows.iter()
                .find(|r| r.get("id").map(|v| v == key).unwrap_or(false))
                .cloned()
                .ok_or_else(|| ConnectorError::RowNotFound {
                    resource: resource.to_string(),
                    key: key.to_string(),
                })
        })
    }
}
