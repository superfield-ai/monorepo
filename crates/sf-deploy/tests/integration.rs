//! Integration tests for `sf-deploy`.
//!
//! These tests exercise the full [`sf_deploy::deploy()`] and
//! [`sf_deploy::rollback()`] paths against a [`StubTransport`] so they require
//! no real infrastructure (no SSH host, no Kubernetes cluster).
//!
//! # Test plan (issue #379 + #380)
//!
//! - Deploy to a local/stub target succeeds.
//! - Invalid target config fails fast before any transport I/O.
//! - Deploy transitions lifecycle from Pending to Live.
//! - Rollback transitions lifecycle from Live to RolledBack.
//! - Rollback restores the prior version identifier.

use sf_deploy::transport::StubTransport;
use sf_deploy::{
    deploy, rollback, BuildArtifact, DeployError, DeploymentLifecycleState, TargetConfig,
};
use std::path::PathBuf;

/// Returns the path to the current test binary, which is guaranteed to exist
/// during test execution. Used as a stand-in for a real artefact file.
fn existing_path() -> PathBuf {
    std::env::current_exe().expect("current_exe() must succeed in tests")
}

// ── Acceptance criteria: a build can be shipped to a configured target ────────

/// Happy path: stub target + valid artefact path → deploy succeeds and
/// [`StubTransport::ship()`] is called exactly once.
#[test]
fn deploy_to_stub_target_succeeds() {
    let transport = StubTransport::new();
    let config = TargetConfig::stub("ci-stub");
    let artifact = BuildArtifact {
        path: existing_path(),
        name: "superfield".to_string(),
    };

    let result =
        deploy(&config, &artifact, &transport).expect("deploy to stub target must succeed");

    assert_eq!(result.target, "ci-stub");
    assert!(
        result.summary.contains("superfield"),
        "summary should mention artefact name: {}",
        result.summary
    );
    assert!(
        result.summary.contains("ci-stub"),
        "summary should mention target name: {}",
        result.summary
    );
    assert_eq!(
        transport.ship_count(),
        1,
        "transport must be called exactly once"
    );
}

/// SSH target with all required fields passes validation and ships.
#[test]
fn deploy_ssh_target_succeeds() {
    let transport = StubTransport::new();
    let config = TargetConfig {
        name: "prod-ssh".to_string(),
        kind: sf_deploy::TargetKind::Ssh,
        host: Some("10.0.0.1".to_string()),
        user: Some("deploy".to_string()),
        dest_dir: Some("/opt/superfield".to_string()),
        namespace: None,
        image: None,
    };
    let artifact = BuildArtifact {
        path: existing_path(),
        name: "superfield".to_string(),
    };

    let result = deploy(&config, &artifact, &transport).unwrap();
    assert_eq!(result.target, "prod-ssh");
    assert_eq!(transport.ship_count(), 1);
}

/// Kubernetes target with all required fields passes validation and ships.
#[test]
fn deploy_kubernetes_target_succeeds() {
    let transport = StubTransport::new();
    let config = TargetConfig {
        name: "k8s-staging".to_string(),
        kind: sf_deploy::TargetKind::Kubernetes,
        host: None,
        user: None,
        dest_dir: None,
        namespace: Some("default".to_string()),
        image: Some("ghcr.io/superfield-ai/superfield:0.1.0".to_string()),
    };
    let artifact = BuildArtifact {
        path: existing_path(),
        name: "superfield".to_string(),
    };

    let result = deploy(&config, &artifact, &transport).unwrap();
    assert_eq!(result.target, "k8s-staging");
    assert_eq!(transport.ship_count(), 1);
}

// ── Acceptance criteria: invalid target config fails fast ─────────────────────

/// Empty target name fails immediately with `InvalidConfig` — no transport I/O.
#[test]
fn invalid_config_empty_name_fails_fast() {
    let transport = StubTransport::new();
    let config = TargetConfig::stub("   "); // whitespace-only name
    let artifact = BuildArtifact {
        path: existing_path(),
        name: "superfield".to_string(),
    };

    let err = deploy(&config, &artifact, &transport).unwrap_err();
    assert!(
        matches!(err, DeployError::InvalidConfig(_)),
        "expected InvalidConfig, got: {:?}",
        err
    );
    // Transport must NOT have been called.
    assert_eq!(
        transport.ship_count(),
        0,
        "transport must not be called on invalid config"
    );
}

/// SSH target missing `host` fails with `InvalidConfig`.
#[test]
fn invalid_config_ssh_missing_host_fails_fast() {
    let transport = StubTransport::new();
    let config = TargetConfig {
        name: "incomplete-ssh".to_string(),
        kind: sf_deploy::TargetKind::Ssh,
        host: None, // missing
        user: Some("deploy".to_string()),
        dest_dir: Some("/opt/superfield".to_string()),
        namespace: None,
        image: None,
    };
    let artifact = BuildArtifact {
        path: existing_path(),
        name: "superfield".to_string(),
    };

    let err = deploy(&config, &artifact, &transport).unwrap_err();
    assert!(matches!(err, DeployError::InvalidConfig(_)));
    assert_eq!(transport.ship_count(), 0);
}

/// SSH target missing `user` fails with `InvalidConfig`.
#[test]
fn invalid_config_ssh_missing_user_fails_fast() {
    let transport = StubTransport::new();
    let config = TargetConfig {
        name: "incomplete-ssh".to_string(),
        kind: sf_deploy::TargetKind::Ssh,
        host: Some("10.0.0.1".to_string()),
        user: None, // missing
        dest_dir: Some("/opt/superfield".to_string()),
        namespace: None,
        image: None,
    };
    let artifact = BuildArtifact {
        path: existing_path(),
        name: "superfield".to_string(),
    };

    let err = deploy(&config, &artifact, &transport).unwrap_err();
    assert!(matches!(err, DeployError::InvalidConfig(_)));
    assert_eq!(transport.ship_count(), 0);
}

/// Kubernetes target missing `image` fails with `InvalidConfig`.
#[test]
fn invalid_config_k8s_missing_image_fails_fast() {
    let transport = StubTransport::new();
    let config = TargetConfig {
        name: "incomplete-k8s".to_string(),
        kind: sf_deploy::TargetKind::Kubernetes,
        host: None,
        user: None,
        dest_dir: None,
        namespace: Some("default".to_string()),
        image: None, // missing
    };
    let artifact = BuildArtifact {
        path: existing_path(),
        name: "superfield".to_string(),
    };

    let err = deploy(&config, &artifact, &transport).unwrap_err();
    assert!(matches!(err, DeployError::InvalidConfig(_)));
    assert_eq!(transport.ship_count(), 0);
}

/// Artefact path does not exist → `ArtifactNotFound` before transport I/O.
#[test]
fn nonexistent_artifact_fails_fast() {
    let transport = StubTransport::new();
    let config = TargetConfig::stub("test");
    let artifact = BuildArtifact {
        path: PathBuf::from("/tmp/sf-deploy-nonexistent-artifact-abc123"),
        name: "superfield".to_string(),
    };

    let err = deploy(&config, &artifact, &transport).unwrap_err();
    assert!(
        matches!(err, DeployError::ArtifactNotFound(_)),
        "expected ArtifactNotFound, got: {:?}",
        err
    );
    assert_eq!(transport.ship_count(), 0);
}

/// Transport failure propagates as `DeployError::Transport`.
#[test]
fn transport_failure_propagates() {
    let transport = StubTransport::failing("simulated network failure");
    let config = TargetConfig::stub("test");
    let artifact = BuildArtifact {
        path: existing_path(),
        name: "superfield".to_string(),
    };

    let err = deploy(&config, &artifact, &transport).unwrap_err();
    assert!(
        matches!(err, DeployError::Transport(_)),
        "expected Transport error, got: {:?}",
        err
    );
}

// ── Config round-trip through serde ───────────────────────────────────────────

/// Target config serialises and deserialises without data loss.
#[test]
fn config_serde_round_trip() {
    let config = TargetConfig {
        name: "prod".to_string(),
        kind: sf_deploy::TargetKind::Ssh,
        host: Some("203.0.113.10".to_string()),
        user: Some("sf".to_string()),
        dest_dir: Some("/srv/superfield".to_string()),
        namespace: None,
        image: None,
    };

    let json = serde_json::to_string(&config).unwrap();
    let restored: TargetConfig = serde_json::from_str(&json).unwrap();

    assert_eq!(restored.name, config.name);
    assert_eq!(restored.kind, config.kind);
    assert_eq!(restored.host, config.host);
    assert_eq!(restored.user, config.user);
    assert_eq!(restored.dest_dir, config.dest_dir);
}

// ── Acceptance criteria: lifecycle states (issue #380) ───────────────────────

/// Deploy transitions the lifecycle record from Pending → Live.
///
/// This is the primary acceptance criterion: "a validated change deploys and
/// reaches a live state."
#[test]
fn deploy_transitions_lifecycle_pending_to_live() {
    let transport = StubTransport::new();
    let config = TargetConfig::stub("prod");
    let artifact = BuildArtifact {
        path: existing_path(),
        name: "superfield".to_string(),
    };

    let result = deploy(&config, &artifact, &transport).expect("deploy must succeed");

    assert_eq!(
        result.record.state,
        DeploymentLifecycleState::Live,
        "lifecycle state must be Live after deploy; got {:?}",
        result.record.state
    );
    assert_eq!(result.record.target, "prod");
    assert_eq!(result.record.artifact_name, "superfield");
    assert_eq!(transport.ship_count(), 1);
}

/// Rollback transitions the lifecycle record from Live → RolledBack and
/// returns the prior version identifier.
///
/// This is the second acceptance criterion: "rollback restores the prior live
/// version."
#[test]
fn rollback_transitions_lifecycle_to_rolled_back() {
    let mut transport = StubTransport::new();
    transport.rollback_version = Some("superfield@sha256:abc123".to_string());

    let config = TargetConfig::stub("prod");
    let artifact = BuildArtifact {
        path: existing_path(),
        name: "superfield".to_string(),
    };

    // First deploy — get the live record.
    let deploy_result = deploy(&config, &artifact, &transport).expect("deploy must succeed");
    assert_eq!(deploy_result.record.state, DeploymentLifecycleState::Live);

    // Now rollback using the live record.
    let rollback_result =
        rollback(deploy_result.record, &transport).expect("rollback must succeed");

    assert_eq!(
        rollback_result.record.state,
        DeploymentLifecycleState::RolledBack,
        "lifecycle state must be RolledBack after rollback; got {:?}",
        rollback_result.record.state
    );
    assert_eq!(
        rollback_result.restored_version, "superfield@sha256:abc123",
        "restored_version must match what the transport reported"
    );
    assert_eq!(rollback_result.target, "prod");
    assert_eq!(transport.rollback_count(), 1);
}

/// A failed rollback (transport error) leaves the record unchanged and
/// propagates `DeployError::Transport`.
#[test]
fn rollback_transport_failure_propagates() {
    let transport = StubTransport::failing("cluster unreachable");
    let config = TargetConfig::stub("prod");
    let artifact = BuildArtifact {
        path: existing_path(),
        name: "superfield".to_string(),
    };

    // Build a live record directly via deploy with a fresh (succeeding) transport.
    let ok_transport = StubTransport::new();
    let deploy_result =
        deploy(&config, &artifact, &ok_transport).expect("initial deploy must succeed");

    // Now attempt rollback with the failing transport.
    let err = rollback(deploy_result.record, &transport).unwrap_err();
    assert!(
        matches!(err, DeployError::Transport(_)),
        "expected Transport error from rollback; got: {:?}",
        err
    );
}
