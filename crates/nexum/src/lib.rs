//! Nexum component — Rust ingestion pipeline on the shared substrate.
//!
//! This crate implements the parse→embed→store ingestion pipeline for the
//! Nexum knowledge-graph component, running in-process on the shared Postgres
//! instance via `sf-db` and the governed embedding model via `sf-embed`.
//!
//! # Pipeline overview
//!
//! 1. **Parse** — split a document into typed blocks (`parse` module).
//! 2. **Dedup** — SHA-256 content hash each block (`dedup` module).
//! 3. **Embed** — produce 384-dim vectors via `sf_embed::Embedder` (`ingest` module).
//! 4. **Store** — write blocks, version, and links to the shared Postgres pool
//!    via `sf-db` (`ingest` module).
//! 5. **Link** — extract structural citation links between blocks (`links` module).
//!
//! # Integration seam
//!
//! Mount via `superfield::mount_nexum()` in the binary entrypoint once the
//! component exposes its service interface.
//!
//! See `docs/architecture.md` §Nexum Ingestion Pipeline.

pub mod dedup;
pub mod ingest;
pub mod links;
pub mod parse;

pub use ingest::{ingest_document, IngestError, IngestOptions, IngestResult};
pub use parse::{parse_document, Block, BlockType, Format};
