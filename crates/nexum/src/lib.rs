//! Nexum component — Rust ingestion and query layer on the shared substrate.
//!
//! This crate implements:
//!
//! - The **parse→embed→store ingestion pipeline** for the Nexum knowledge-graph
//!   component (`ingest`, `parse`, `dedup`, `links` modules).
//! - The **query layer** for full-text, semantic (pgvector HNSW), graph
//!   (recursive CTE), and hybrid searches (`query` module).
//!
//! All operations run in-process against the shared Postgres instance via
//! `sf-db` and the governed 384-dim embedding model via `sf-embed`.
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
//! # Query overview
//!
//! - [`query::fulltext_search`] — `plainto_tsquery` full-text search.
//! - [`query::semantic_search`] — pgvector HNSW ANN search with cosine distance.
//! - [`query::graph_search`] — recursive CTE graph traversal (not AGE).
//! - [`query::hybrid_search`] — semantic seed + one-hop graph expansion.
//!
//! # Integration seam
//!
//! Mount via `superfield::mount_nexum()` in the binary entrypoint once the
//! component exposes its service interface.
//!
//! See `docs/architecture.md` §Nexum and §Single-Instance Database Schema Layout.

pub mod dedup;
pub mod ingest;
pub mod links;
pub mod parse;
pub mod query;

pub use ingest::{ingest_document, IngestError, IngestOptions, IngestResult};
pub use parse::{parse_document, Block, BlockType, Format};
pub use query::{
    fulltext_search, graph_search, hybrid_search, semantic_search, BlockResult, DocRef,
    FullTextOptions, GraphOptions, GraphResult, HybridOptions, QueryError, SemanticOptions,
};
