# Nexum

Block-level document intelligence. Ingests documents (PDF, DOCX, Markdown), parses them into addressable blocks (sentences, paragraphs), and builds a typed cross-link graph across any corpus — legal, medical, research, or business.

See [`docs/engineering.md`](docs/engineering.md) for the full data model and query design.

---

## Prerequisites

- **Node.js** ≥ 20
- **Docker** — used to run PostgreSQL with Apache AGE + pgvector (`apache/age:PG16_latest`)
- **pdftotext** (poppler-utils) — optional, for PDF ingestion

Embeddings are computed locally via [`@xenova/transformers`](https://github.com/xenova/transformers.js) — no external API keys required.

---

## Quick Start

```bash
# 1. Clone and install
git clone git@github.com:superfield-ai/nexum.git
cd nexum
npm install

# 2. Start Postgres + Apache AGE (the only supported image post-phase-1)
docker compose up -d postgres
# (or, equivalently, run the image directly:)
# docker run -d --name nexum-pg \
#   -e POSTGRES_DB=nexum -e POSTGRES_USER=nexum -e POSTGRES_PASSWORD=nexum \
#   -p 5432:5432 apache/age:PG16_latest

# 3. Configure environment
cp .env.example .env
# DATABASE_URL=postgresql://nexum:nexum@localhost:5432/nexum

# 4. Start the server (auto-migrates on first run)
npm run dev

# 5. Seed with demo contract data
npm run seed
```

---

## API Reference

The full OpenAPI 3.0 spec is served at runtime:

```
GET http://localhost:3000/openapi.json
```

A static copy lives at [`openapi.json`](./openapi.json) in the repo root.

### Core Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `POST` | `/corpora` | Create a document corpus |
| `GET` | `/corpora/:id` | Get corpus by ID |
| `POST` | `/documents` | Ingest a document (returns block count) |
| `POST` | `/query` | Query across blocks (vector / graph / hybrid) |
| `POST` | `/blocks/embed` | Embed a text snippet |
| `POST` | `/entities` | Create an entity (user or agent) |
| `GET` | `/openapi.json` | OpenAPI spec |

### Example: Query

```bash
curl -s -X POST http://localhost:3000/query \
  -H 'Content-Type: application/json' \
  -d '{"corpus_id":"<id>","query":"indemnification","mode":"vector"}'
```

---

## Running

```bash
# Development (watch mode)
npm run dev

# Production build + run
npm run build
npm start

# Seed demo data (server must be running)
npm run seed
```

---

## Testing

```bash
# Unit tests
npm test

# Integration tests (requires running Postgres)
npm run test:integration
```

Integration tests run against a real database — there are no mocks for the DB layer. Set `DATABASE_URL` to point at a test database.

---

## Key Concepts

**Block** — the atomic unit. One paragraph or sentence, with a stable UUID, an embedding vector, a SHA-256 content hash (for dedup across versions), and a `parent_block_id` pointing to its predecessor in prior versions.

**Link** — a typed edge between two blocks. Three layers: `structural` (extracted citations), `semantic` (embedding similarity), `ai` (LLM-classified). Each link carries a `provenance` JSONB with model, confidence, and timestamp.

**Version dedup** — when a new version of a document is ingested, unchanged blocks (same content hash) reuse their existing UUID and inherit all existing links automatically. Only modified or new blocks are re-embedded and re-linked.

**Query modes** — PostgreSQL handles all four: full-text (`tsvector`), semantic (pgvector HNSW ANN), graph traversal (recursive CTEs), and hybrid.

---

## Project Structure

```
nexum/
├── openapi.json            # Static OpenAPI 3.0 spec
├── scripts/
│   └── seed.ts             # Demo corpus seeder
├── src/
│   ├── routes/             # HTTP route handlers
│   ├── ingest/             # Ingestion pipeline (parse → embed → link)
│   ├── query/              # Query engine (semantic, full-text, graph)
│   └── db/                 # Migrations and schema
├── docs/
│   ├── engineering.md      # Data model, queries, pipeline design
│   └── product.md          # Feature overview
└── tests/
    ├── unit/
    └── integration/
```
