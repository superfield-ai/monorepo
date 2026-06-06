# Nexum — Competitive Landscape

_Last updated: 2026-04-27. Focused on low-level tools, infrastructure, and research papers. High-level legal AI assistants (Harvey, CoCounsel, Luminance) are noted briefly in the positioning summary; they are not the relevant competitive set._

---

## Strategic Finding

No current commercial product occupies Nexum's specific position: block-level parsing with version-aware dedup, a queryable multi-typed relationship graph across blocks, and legal-domain specificity with private corpus support. The consistent pattern across every tool surveyed is: **the block is ingested but not related.** Docling gives you paragraph-level blocks. Unstructured gives you typed elements. LlamaIndex builds entity graphs from chunk content. Weaviate stores chunks as nodes. None model explicit typed relationships *between* blocks across documents — the "contradicts", "elaborates", "overrides" edge types with confidence metadata and provenance that Nexum requires.

The research literature confirms the same gap: fine-grained citation work operates at subsentence level *within* documents; legal citation prediction operates at *document* level; no published system does typed block-to-block relationships across legal documents with versioning.

---

## Document Parsing and Chunking

### Docling (IBM)
Open-sourced July 2024, MIT license. The most complete open-source document parsing toolkit available and the strongest candidate for Nexum's ingestion layer.

Internal representation is `DoclingDocument` (defined in `docling-core`). Element taxonomy: paragraphs, headings (with level), tables (cell-level structure), figures, captions, lists, list items, code blocks. Each block carries: bounding box, page number, reading order index, and parent reference for hierarchy reconstruction. Export formats: lossless JSON, Markdown, HTML, DocTags. JSON export preserves all spatial and structural metadata.

Architecture spans 8 repos: `docling` (main), `docling-core` (types), `docling-parse` (C++ PDF backend), `docling-serve` (FastAPI), `docling-ibm-models` (layout detection + TableFormer for table cells), `docling-sdg`, `docling-mcp`, `docling-java`. The AI pipeline uses an object detection model over page images combined with a programmatic text layer, reconciling both for accuracy. Input formats: PDF, DOCX, PPTX, XLSX, HTML, Markdown, LaTeX, images, USPTO XML, JATS XML, XBRL XML.

**For Nexum:** Docling's lossless JSON gives paragraph-level blocks with bounding boxes and parent/child hierarchy that maps directly to the blocks schema. It handles all three of our source formats. It does not model cross-document relationships — that layer is ours to build.

### Unstructured.io
Partitioning → chunking pipeline. Typed elements: `Title`, `NarrativeText`, `ListItem`, `Table`, `Image`, `Header`, `Footer`, `PageBreak`, `FigureCaption`, `CodeSnippet`. Tables exported as HTML strings. Each element carries `filename`, `page_number`, `coordinates` (bounding polygon), `parent_id`, `category_depth`, `languages`.

The `parent_id` field creates a shallow parent/child tree from heading elements to subordinate content (one level of grouping). Chunking strategies: `basic` (character count), `by_title` (section-boundary-aware), `by_page`, `by_similarity` (cosine). The proprietary "Chipper" model (vision encoder-decoder) handles complex PDFs; open-source package uses rule-based approaches.

**For Nexum:** Element type labels (`NarrativeText`, `Title`) map directly to `block_type`. Richer element metadata than Docling but shallower hierarchy. Cross-document references entirely absent. Use Unstructured as a fallback parser or for format types Docling doesn't handle as well.

### Chonkie (2024/2025)
Minimal-dependency chunking library. Chunkers: `TokenChunker`, `SentenceChunker`, `RecursiveChunker`, `SemanticChunker`, `LateChunker`. The `LateChunker` is architecturally interesting: embeds the full document first, then splits the embedding sequence — so each chunk embedding reflects global document context rather than being computed in isolation. No document structure model, no cross-document relationships. Useful only if Nexum needs an embedding-preserving chunking strategy.

### Kira Systems / Litera
Closed system, no public developer API at chunk level. ML core uses supervised learning trained on 1M+ documents and 500K labeled examples (40K+ lawyer-hours of annotation). Output unit is a "smart field" — clause-level span — formulated as a span-selection QA task (start/end character offsets). Ships with 1,400+ pre-built smart fields across 40+ legal practice areas. "Quick Study" allows custom extractors via weak supervision. "Smart Summaries" (2023) layers a generative model on top of extracted spans.

**Critical gap for Nexum:** Kira extracts span-level data but does not model *relationships between clauses* across documents. Output is a flat list of labeled spans per document — not a graph. There is no edge layer, no cross-document linking, no typed relationships.

---

## Graph + Vector Hybrid Stores

### Weaviate — Cross-References
Cross-references allow an object to reference other objects by UUID. References are typed only by property name (e.g., `hasCitation`) declared in the schema — there is no first-class relationship type with edge-level metadata. You cannot attach `weight`, `confidence`, or `provenance` to a reference without creating an intermediate junction object.

At query time, cross-references trigger nested GraphQL lookups — Weaviate's own documentation warns these are significantly slower at scale and recommends avoiding them where possible. A documented bug (March 2024, issue #4527) causes OOM crashes when cyclic cross-references exist and are traversed in nested queries. For Nexum's typed, weighted, provenance-bearing block relationships, Weaviate's cross-reference model is insufficient without an intermediate "Relationship" collection — which further degrades query performance.

### Neo4j + Vector Search
Native vector indexing added in v5.11 (2023). The LangChain/Neo4j document pattern: `(:Document)-[:HAS_CHUNK]→(:Chunk)`, `(:Chunk)-[:NEXT]→(:Chunk)`, `(:Chunk)-[:MENTIONS]→(:Entity)`, `(:Chunk)-[:SIMILAR {score}]→(:Chunk)`. Typed relationships with arbitrary edge properties are natively supported — Neo4j's property graph model is architecturally correct for Nexum's typed relationship layer. The limitation: standalone server (not embeddable), dual-database architecture alongside PostgreSQL, and thinner compliance/audit tooling than Postgres.

### Microsoft GraphRAG (open source, April 2024)
Pipeline: (1) chunk documents into `TextUnit` nodes, (2) LLM-extract entities and relationships per TextUnit, (3) entity graph construction, (4) Leiden community detection, (5) LLM-generated community summaries at each hierarchy level. TextUnit nodes (chunks) are first-class graph nodes — they link to the entities they mention. But relationships are entity-to-entity, not chunk-to-chunk. No typed block-to-block relationships exist ("this paragraph contradicts that paragraph") — the chunk graph is implicit via entity co-occurrence. Relevant to Nexum for the AI linking stage architecture; not a substitute for the block graph model.

### FalkorDB
Redis module implementing a property graph using GraphBLAS sparse matrix representations. Supports OpenCypher, integrated HNSW vector indexing, and full-text search — all in a single process. Claimed up to 200x faster than other graph databases on certain multi-hop traversal workloads. Multi-graph isolation supported. The vector index allows vector similarity search inline in Cypher queries. For Nexum: appealing as an integrated graph + vector + full-text store, but does not replace PostgreSQL as a transactional source of truth.

### Kuzu
Embeddable columnar property graph database (BSD-3 license). Runs in-process (Python, Rust, Go, Java, Node, WASM) — no separate server. Columnar storage optimized for OLAP-style multi-hop queries: ~18x faster ingestion and significantly faster multi-hop traversal than Neo4j in benchmarks. Cypher query language. Vector search and full-text search built in as extensions (`vector`, `fts`) since v0.11. Rust bindings available via the `kuzu` crate on crates.io.

**For Nexum:** The most practical choice if PostgreSQL recursive CTEs degrade past 5–6 hops at scale. Kuzu can be populated as a graph snapshot from Postgres and queried in-process from the Rust ingestion pipeline without running a separate database server.

### ArangoDB
Native multi-model: document + graph + vector (FAISS integration, November 2024) + full-text in unified AQL queries. Graph edges are documents with `_from` and `_to` fields that carry arbitrary metadata — relationship type, confidence score, provenance — making ArangoDB natively capable of Nexum's typed relationship model without a junction table hack. Their "HybridGraphRAG" pattern combines all four in a single AQL query. Trade-off: AQL instead of SQL, thinner ecosystem tooling than Neo4j or Postgres.

---

## Research Papers

### "From Local to Global: A Graph RAG Approach to Query-Focused Summarization"
Edge et al., Microsoft Research. arXiv 2404.16130. 2024.
Introduced the canonical GraphRAG pipeline: TextUnit chunks → entity/relationship extraction → Leiden community detection → hierarchical community summaries. TextUnits are chunk-level nodes but all relationships are entity-centric. The architectural reference for chunk-as-node paradigm and its entity-extraction limitations. Directly relevant to Nexum's AI linking stage design.

### "Retrieval-Augmented Generation with Graphs (GraphRAG)" — Survey
Han et al. arXiv 2501.00309. Dec 2024/Jan 2025.
Comprehensive taxonomy of GraphRAG across 10 application domains. Notes that document graphs, entity graphs, and community graphs require distinct architectural designs, and that "graph-structured data lacks explicit transferable units across domains" — a direct statement of the unsolved problem Nexum addresses for legal documents.

### "RAPTOR: Recursive Abstractive Processing for Tree-Organized Retrieval"
Sarthi et al., Stanford NLP. arXiv 2401.18059. ICLR 2024.
Builds a tree index over document corpora via recursive chunk clustering (GMM) and LLM summarization. Retrieval queries both leaf chunks and internal summary nodes. No typed relationships, no structural links, no cross-document provenance. The baseline hierarchical chunking approach Nexum's block graph supersedes.

### "HiChunk: Evaluating and Enhancing RAG with Hierarchical Chunking"
Lu, Chen, Qiao, Sun. arXiv 2509.11552. EMNLP 2025 (Findings).
Introduces HiCBench (manually annotated multi-level chunking points) and Auto-Merge retrieval: retrieve at fine-grained block level, merge upward into parent chunks if evidence is insufficient. Directly relevant to Nexum's design of fine-grained block retrieval with structural parent/child rollup — validates the approach empirically.

### "Verifiable Generation with Subsentence-Level Fine-Grained Citations"
Cao, Wang. NAACL 2024 Findings. arXiv 2406.06125.
Introduces SCiFi: 10K Wikipedia paragraphs with subsentence-level citation annotations. Frames citation as a span-linking problem — which subsentence in generated text is supported by which span in a source document. The closest research analog to Nexum's block-level citation graph. Limitation: targets LLM output verification, not document-to-document structural linking.

### "The Missing Link: Joint Legal Citation Prediction using Heterogeneous Graph Enrichment"
Wendlinger et al. arXiv 2506.22165. 2025.
Proposes HGE (Heterogeneous Graph Enrichment), a GNN jointly predicting Case-Case and Case-Law citations using a heterogeneous graph with two node types (cases, laws) and two edge types. Operates at document level, explicitly noting paragraph-level prediction as future work. State of the art for legal citation graphs — but document-granular, not block-granular, which is the gap Nexum fills.

### "LongCite: Enabling LLMs to Generate Fine-Grained Citations in Long-Context QA"
Bai et al. arXiv 2409.02897. 2024.
Sentence-level citation generation in long-context settings via CoF (Chain-of-Thought Citation) training data. Demonstrates that sentence-level citation is achievable and preferred over document-level. Validates Nexum's fine-grained block indexing approach.

### "NLP for the Legal Domain: A Survey of Tasks, Datasets, Models, and Challenges"
arXiv 2410.21306. ACM Computing Surveys. October 2024.
Covers legal NLP comprehensively: clause extraction, citation prediction, judgement prediction, argument mining, summarization. Identifies open challenges: (1) no datasets with cross-document structural links at sub-document granularity, (2) no standard representation for inter-clause relationships (contradicts, supersedes), (3) long-document modeling. Directly maps to Nexum's motivation — shows the infrastructure Nexum needs does not yet exist.

### "Automating Construction Contract Review using Knowledge Graph-Enhanced LLMs"
Lv et al. ScienceDirect 2025.
Introduces NCKG (Nested Contract Knowledge Graph): clause nodes contain sub-clause nodes, connected to entity and obligation nodes, using GraphRAG for retrieval. The "nested" structure is the closest published model to Nexum's block graph — treats clause and sub-clause as distinct node types with containment edges. Proof-of-concept for hierarchical block graphs in legal domain, though without cross-document versioning or typed logical relationships.

### "Enhancing RAG with Hierarchical Text Segmentation and Chunking"
arXiv 2507.09935. 2025.
Hierarchical text segmentation combined with clustering for semantically coherent chunks. Evaluated on NarrativeQA, QuALITY, QASPER. Shows hierarchical segmentation outperforms fixed-size chunking for multi-hop retrieval — empirical validation that preserving structural boundaries improves retrieval quality.

---

## Positioning Summary

| Dimension | Nexum | Weaviate | LlamaIndex / LangChain | Kira/Litera | GraphRAG | Neo4j | Kuzu |
|-----------|-------|----------|------------------------|-------------|----------|-------|------|
| Block-level granularity | Yes | Yes (manual) | Chunk-level | Clause (field-only) | TextUnit | Chunk | Chunk |
| Typed cross-doc edges | Yes | Partial (no edge props) | Entity-level only | No | Entity-level | Yes | Yes |
| Edge provenance/weight | Yes | No | No | No | No | Yes | Yes |
| Multi-hop traversal | Recursive CTE | No | No | No | Community | Cypher | Cypher |
| Document versioning + block dedup | Yes | No | No | No | No | No | No |
| Legal citation parsing | Yes | No | No | Clause extraction | No | No | No |
| Single-store (vector + graph + FTS) | Yes (Postgres) | Vector only | No | No | No | Near (v5.11+) | Yes (extensions) |
| Embeddable in Rust | Postgres client | No | No | No | No | No | Yes (kuzu crate) |
| Open source / no vendor lock | Yes | Yes | Yes | No | Yes | Partial | Yes |

**Closest technical neighbors:**
- **Kuzu** — embeddable, typed property graph, Rust bindings, built-in vector. Potential future graph traversal layer if Postgres CTEs bottleneck.
- **ArangoDB** — multi-model with edge metadata. The only commercial alternative with the right data model, but AQL instead of SQL.
- **NCKG paper (Lv 2025)** — nearest research analog: nested block graph for legal documents.

**The gap in one sentence:** every system either has blocks without relationships, or relationships without block-level granularity, or typed relationships without document versioning. Nexum is the first to combine all three with a legal-domain parser and a Postgres-native stack.
