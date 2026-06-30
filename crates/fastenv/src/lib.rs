// lib.rs — Library entry point for fastenv.
//
// Exposes internal modules for benchmarks and integration tests.
// The binary entry point is src/main.rs.
//
// Canonical docs:
//   - docs/prd.md
//   - crates/fastenv/docs/architecture.md

pub mod bench;
pub mod boundary;
pub mod build_base;
// ci_executor / ci_gate / ci_import — CI job-manifest decoupling seams
// (dev-scout stubs, issue #821; canonical docs/adr-ci-execution-manifest.md).
// Each is a compile-safe, no-op boundary owning a DISJOINT file so the three
// downstream features land in parallel against the stable `manifest` schema:
//   ci_executor — run the job graph (real impl #822)
//   ci_import   — round-trip GHA YAML <-> manifest (real impl #823)
//   ci_gate     — enforce the four invariants + ci-taxonomy (real impl #824)
pub mod ci_executor;
pub mod ci_gate;
pub mod ci_import;
pub mod container_runtime;
// deployment — deployment-tier runtime seam (dev-scout stub, issue #663).
// Compile-safe, no-op supervisor for long-lived workloads; real impl is #662.
pub mod deployment;
pub mod diff;
pub mod discard;
pub mod doctor;
pub mod du;
pub mod e2e_smoke;
pub mod exec;
pub mod export_patch;
pub mod fork;
pub mod gc;
pub mod guest_ebpf;
pub mod guest_harness;
pub mod host_control_plane;
pub mod host_ebpf;
// manifest — the versioned, substrate-agnostic CI job-manifest schema
// (issue #821). The foundational contract the three seams above consume.
pub mod manifest;
pub mod mount_path;
pub mod privileged_harness;
pub mod quota;
pub mod registry;
pub mod security_regression;

// parity_check is declared in main.rs only because it references crate::Cli.
// It cannot be part of the library crate without moving the Cli struct here.
// See src/parity_check.rs for the Phase 6 parity table.
