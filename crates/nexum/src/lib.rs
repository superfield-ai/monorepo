//! Nexum component — Rust ingestion and query layer on the shared substrate.
//!
//! This crate implements:
//!
//! - The **parse→embed→store ingestion pipeline** for the Nexum knowledge-graph
//!   component (`ingest`, `parse`, `dedup`, `links` modules).
//! - The **query layer** for full-text, semantic (pgvector HNSW), graph
//!   (recursive CTE), and hybrid searches (`query` module).
//! - The **causal-chain query** for error diagnosis — traverses
//!   error → session → user → requirement → code in a single call
//!   (`causal_chain` module, issue #382).
//!
//! All operations run in-process against the shared Postgres instance via
//! `sf-db` and the governed 384-dim embedding model via the in-crate
//! [`embed`] module (a pure-Rust `candle` BERT embedder).
//!
//! # Pipeline overview
//!
//! 1. **Parse** — split a document into typed blocks (`parse` module).
//! 2. **Dedup** — SHA-256 content hash each block (`dedup` module).
//! 3. **Embed** — produce 384-dim vectors via [`embed::Embedder`] (`ingest` module).
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
//! - [`causal_chain::error_to_cause_chain`] — error-to-cause chain for agent diagnosis.
//!
//! # Integration seam
//!
//! Mount via `superfield::mount_nexum()` in the binary entrypoint once the
//! component exposes its service interface.
//!
//! See `docs/architecture.md` §Nexum and §Single-Instance Database Schema Layout.

pub mod ai_link;
pub mod causal_chain;
pub mod dedup;
pub mod embed;
pub mod ingest;
pub mod links;
pub mod parse;
pub mod query;

pub use ai_link::{classify_pair, process_ai_links, AiLinkError};
pub use causal_chain::{error_to_cause_chain, CausalChain, CausalChainError, ChainNode};
pub use ingest::{ingest_document, IngestError, IngestOptions, IngestResult};
pub use parse::{parse_document, Block, BlockType, Format};
pub use query::{
    edge_semantic_search, fulltext_search, graph_search, hybrid_search, semantic_search,
    BlockResult, DocRef, EdgeBlockRef, EdgeProbe, EdgeResult, EdgeSemanticOptions, FullTextOptions,
    GraphOptions, GraphResult, HybridOptions, QueryError, SemanticOptions,
};
