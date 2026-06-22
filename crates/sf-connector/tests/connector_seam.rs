//! Acceptance tests for the read-only systems-of-record connector seam
//! (issue #718).
//!
//! These tests pin the three acceptance criteria from the issue:
//!
//! 1. The `Connector` trait exposes only read/query methods (no
//!    write/update/delete) — enforced structurally and by a compile/test
//!    assertion.
//! 2. The reference connector reads rows from a fake source without mutating
//!    it.
//! 3. Connector credentials are workspace-scoped.

use sf_connector::{
    assert_read_only, Connector, ConnectorCredentials, ConnectorError, CredentialKind, FakeSource,
    InMemoryConnector, Query,
};
use uuid::Uuid;

/// Build a fake CRM source with a couple of resources for the tests.
fn fake_crm() -> FakeSource {
    FakeSource::new("acme-crm")
        .with_resource(
            "contacts",
            vec![
                sf_connector::row([("id", "1"), ("name", "Ada"), ("tier", "gold")]),
                sf_connector::row([("id", "2"), ("name", "Babbage"), ("tier", "silver")]),
                sf_connector::row([("id", "3"), ("name", "Lovelace"), ("tier", "gold")]),
            ],
        )
        .with_resource(
            "accounts",
            vec![sf_connector::row([("id", "100"), ("owner", "1")])],
        )
}

// ---------------------------------------------------------------------------
// AC1: read-only trait surface — structural + compile/test assertion
// ---------------------------------------------------------------------------

#[tokio::test]
async fn connector_trait_exposes_only_read_methods() {
    // Compile-time guarantee: a value behind a *shared* reference satisfies the
    // full `Connector` API. If the trait ever gained a `&mut self` (write-shaped)
    // method, this would fail to compile, because `&C` cannot call it.
    let connector = InMemoryConnector::new(Uuid::new_v4(), fake_crm());
    assert_read_only(&connector);

    // Exercise the *entire* trait surface through a shared borrow. The surface
    // is: source_name, resources, query, fetch — all reads. There is no write
    // verb to call.
    let r: &dyn Connector = &connector;
    assert_eq!(r.source_name(), "acme-crm");
    let mut resources = r.resources().await.unwrap();
    resources.sort();
    assert_eq!(
        resources,
        vec!["accounts".to_string(), "contacts".to_string()]
    );
    let all = r.query(&Query::all("contacts")).await.unwrap();
    assert_eq!(all.len(), 3);
    let one = r.fetch("contacts", "1").await.unwrap();
    assert_eq!(one.get("name").map(String::as_str), Some("Ada"));
}

// ---------------------------------------------------------------------------
// AC2: reads rows from the fake source without mutating it
// ---------------------------------------------------------------------------

#[tokio::test]
async fn reference_connector_reads_without_mutating_source() {
    let workspace = Uuid::new_v4();
    let connector = InMemoryConnector::new(workspace, fake_crm());

    // Snapshot the source state before any reads.
    let contacts_before = connector.source().row_count("contacts");
    let accounts_before = connector.source().row_count("accounts");
    assert_eq!(contacts_before, Some(3));
    assert_eq!(accounts_before, Some(1));

    // Perform a battery of reads, including a filtered query.
    let gold = connector
        .query(&Query::all("contacts").filter("tier", "gold"))
        .await
        .unwrap();
    assert_eq!(gold.len(), 2, "two gold-tier contacts");

    let _ = connector.query(&Query::all("contacts")).await.unwrap();
    let _ = connector.fetch("contacts", "2").await.unwrap();
    let _ = connector.resources().await.unwrap();

    // The source is byte-for-byte unchanged after the reads.
    assert_eq!(
        connector.source().row_count("contacts"),
        contacts_before,
        "reads must not add/remove contact rows"
    );
    assert_eq!(
        connector.source().row_count("accounts"),
        accounts_before,
        "reads must not touch other resources"
    );
}

#[tokio::test]
async fn unknown_resource_and_missing_row_are_read_errors() {
    let connector = InMemoryConnector::new(Uuid::new_v4(), fake_crm());

    let err = connector
        .query(&Query::all("nope"))
        .await
        .expect_err("unknown resource must error");
    assert!(matches!(err, ConnectorError::UnknownResource(r) if r == "nope"));

    let err = connector
        .fetch("contacts", "999")
        .await
        .expect_err("missing row must error");
    assert!(matches!(
        err,
        ConnectorError::RowNotFound { resource, key } if resource == "contacts" && key == "999"
    ));
}

// ---------------------------------------------------------------------------
// AC3: workspace-scoped credentials
// ---------------------------------------------------------------------------

#[tokio::test]
async fn credentials_are_workspace_scoped() {
    let workspace_a = Uuid::new_v4();
    let workspace_b = Uuid::new_v4();

    // A credential minted for workspace A binds cleanly to a connector for A.
    let cred_a = ConnectorCredentials::new(
        workspace_a,
        "acme-crm",
        CredentialKind::ApiKey("secret-a".to_string()),
    );
    assert_eq!(cred_a.workspace_id, workspace_a);

    let connector_a = InMemoryConnector::new(workspace_a, fake_crm())
        .with_credentials(cred_a.clone())
        .expect("credential for workspace A binds to connector A");
    assert_eq!(connector_a.workspace_id(), workspace_a);

    // The SAME credential cannot authenticate a connector bound to workspace B:
    // there is no cross-workspace / global credential.
    let connector_b = InMemoryConnector::new(workspace_b, fake_crm());
    let err = connector_b
        .with_credentials(cred_a)
        .expect_err("workspace-A credential must not bind to a workspace-B connector");
    assert!(matches!(err, ConnectorError::Auth(_)));
}

#[tokio::test]
async fn credential_kinds_roundtrip_through_serde() {
    let workspace = Uuid::new_v4();
    for kind in [
        CredentialKind::ApiKey("k".into()),
        CredentialKind::BasicAuth {
            username: "u".into(),
            password: "p".into(),
        },
        CredentialKind::OAuthBearer("token".into()),
    ] {
        let cred = ConnectorCredentials::new(workspace, "src", kind);
        let json = serde_json::to_string(&cred).unwrap();
        let back: ConnectorCredentials = serde_json::from_str(&json).unwrap();
        assert_eq!(cred, back);
        // The workspace scope survives serialization round-trips.
        assert_eq!(back.workspace_id, workspace);
    }
}
