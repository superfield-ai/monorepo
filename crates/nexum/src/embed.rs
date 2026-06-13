//! In-process embedding for the Nexum component (inlined from the former
//! `sf-embed` crate).
//!
//! Embeds text using `sentence-transformers/all-MiniLM-L6-v2` (384 dimensions)
//! via the `candle` pure-Rust ML framework.  No Node/JS runtime, no pre-built
//! native ONNX binaries, and no external process are required.
//!
//! # Governance constants
//!
//! [`GOVERNED_MODEL`] names the embedding model that every component must use.
//! [`GOVERNED_MODEL_REVISION`] pins the HuggingFace Hub commit SHA for
//! reproducible weight downloads; it matches `models/embedding.lock`.
//! [`GOVERNED_DIM`] is the output vector size that schema columns, index
//! parameters, and cosine-similarity queries depend on.  Any change requires a
//! corpus re-embedding pass and a schema migration — treat them as major
//! breaking changes.
//!
//! # Model weight caching
//!
//! Weights are downloaded from HuggingFace Hub on first use and cached in the
//! `hf-hub` default cache directory (`~/.cache/huggingface/hub/`).  Subsequent
//! calls are fast.

use candle_core::{DType, Device, Tensor};
use candle_nn::VarBuilder;
use candle_transformers::models::bert::{BertModel, Config, DTYPE};
use hf_hub::{api::sync::Api, Repo, RepoType};
use thiserror::Error;
use tokenizers::Tokenizer;

// ── Governance constants ──────────────────────────────────────────────────────

/// HuggingFace model ID of the governed embedding model.
pub const GOVERNED_MODEL: &str = "sentence-transformers/all-MiniLM-L6-v2";

/// Pinned HuggingFace Hub commit SHA for the governed model.
///
/// Pass this to `Repo::with_revision` to guarantee reproducible weight
/// downloads in CI and production.  See `models/embedding.lock`.
pub const GOVERNED_MODEL_REVISION: &str = "c9745ed";

/// Output dimension of the governed embedding model.
///
/// All pgvector columns, HNSW index parameters, and similarity queries must
/// be sized to this value.  Changing it without re-embedding every corpus
/// will corrupt similarity scores silently.
pub const GOVERNED_DIM: usize = 384;

// ── Error type ────────────────────────────────────────────────────────────────

/// Errors produced by the embedder.
#[derive(Debug, Error)]
pub enum EmbedError {
    /// The model weights or tokenizer could not be loaded from the Hub or disk.
    #[error("failed to load embedding model: {0}")]
    ModelLoad(String),

    /// The tokenizer failed to encode the input text.
    #[error("tokenization failed: {0}")]
    Tokenize(String),

    /// Tensor computation failed during inference.
    #[error("embedding inference failed: {0}")]
    Inference(String),

    /// The model returned a vector whose length does not match [`GOVERNED_DIM`].
    /// Indicates a version skew or configuration error.
    #[error("unexpected embedding dimension: got {got}, expected {expected}")]
    DimensionMismatch { got: usize, expected: usize },
}

impl From<candle_core::Error> for EmbedError {
    fn from(e: candle_core::Error) -> Self {
        EmbedError::Inference(e.to_string())
    }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/// Compute the mean of token embeddings, masking out padding tokens.
fn mean_pool(embeddings: &Tensor, attention_mask: &Tensor) -> Result<Tensor, candle_core::Error> {
    // embeddings:     [batch, seq_len, hidden]
    // attention_mask: [batch, seq_len]
    let (batch, seq_len, hidden) = embeddings.dims3()?;

    // Expand mask to [batch, seq_len, hidden] for element-wise multiply.
    let mask = attention_mask
        .unsqueeze(2)? // [batch, seq_len, 1]
        .expand((batch, seq_len, hidden))? // [batch, seq_len, hidden]
        .to_dtype(embeddings.dtype())?;

    let masked_sum = (embeddings * &mask)?.sum(1)?; // [batch, hidden]

    // Count non-padding tokens per batch row: [batch, 1] → [batch, hidden].
    let count = attention_mask
        .to_dtype(embeddings.dtype())?
        .sum_keepdim(candle_core::D::Minus1)? // [batch, 1]
        .expand((batch, hidden))?; // [batch, hidden]

    masked_sum / count
}

/// L2-normalise a 2-D tensor of shape [batch, dim].
fn l2_normalize(tensor: &Tensor) -> Result<Tensor, candle_core::Error> {
    // Compute per-row L2 norm: sum of squares → sqrt → expand to [batch, dim].
    let (batch, dim) = tensor.dims2()?;
    let norm = tensor
        .sqr()?
        .sum_keepdim(candle_core::D::Minus1)? // [batch, 1]
        .sqrt()?
        .expand((batch, dim))?; // [batch, dim]
    tensor / norm
}

// ── Public API ────────────────────────────────────────────────────────────────

/// An in-process BERT embedder backed by [`GOVERNED_MODEL`].
///
/// Construct once via [`Embedder::new`] and reuse across the application.
/// Model weights are downloaded from HuggingFace Hub on first construction
/// and cached locally; subsequent instantiations are fast.
///
/// # Example
/// ```no_run
/// use nexum::embed::Embedder;
///
/// let embedder = Embedder::new().expect("model load failed");
/// let vec = embedder.embed_one("hello world").expect("embed failed");
/// assert_eq!(vec.len(), nexum::embed::GOVERNED_DIM);
/// ```
pub struct Embedder {
    model: BertModel,
    tokenizer: Tokenizer,
    device: Device,
}

impl Embedder {
    /// Initialise the embedder.  Downloads model weights from HuggingFace Hub
    /// if not already cached.  CPU-only; GPU support can be added later by
    /// exposing a device parameter.
    pub fn new() -> Result<Self, EmbedError> {
        let device = Device::Cpu;
        let api = Api::new().map_err(|e| EmbedError::ModelLoad(e.to_string()))?;
        // Use the pinned revision from GOVERNED_MODEL_REVISION for reproducibility.
        let repo = api.repo(Repo::with_revision(
            GOVERNED_MODEL.to_string(),
            RepoType::Model,
            GOVERNED_MODEL_REVISION.to_string(),
        ));

        let config_path = repo
            .get("config.json")
            .map_err(|e| EmbedError::ModelLoad(e.to_string()))?;
        let tokenizer_path = repo
            .get("tokenizer.json")
            .map_err(|e| EmbedError::ModelLoad(e.to_string()))?;
        let weights_path = repo
            .get("model.safetensors")
            .map_err(|e| EmbedError::ModelLoad(e.to_string()))?;

        let config_str = std::fs::read_to_string(&config_path)
            .map_err(|e| EmbedError::ModelLoad(e.to_string()))?;
        let config: Config =
            serde_json::from_str(&config_str).map_err(|e| EmbedError::ModelLoad(e.to_string()))?;

        let tokenizer = Tokenizer::from_file(&tokenizer_path)
            .map_err(|e| EmbedError::ModelLoad(e.to_string()))?;

        let vb = unsafe {
            VarBuilder::from_mmaped_safetensors(&[weights_path], DTYPE, &device)
                .map_err(|e| EmbedError::ModelLoad(e.to_string()))?
        };
        let model =
            BertModel::load(vb, &config).map_err(|e| EmbedError::ModelLoad(e.to_string()))?;

        Ok(Self {
            model,
            tokenizer,
            device,
        })
    }

    /// Embed a single text snippet.  Returns a normalised `GOVERNED_DIM`-element
    /// vector suitable for cosine-similarity comparisons.
    pub fn embed_one(&self, text: &str) -> Result<Vec<f32>, EmbedError> {
        let mut results = self.embed_batch(&[text])?;
        results
            .pop()
            .ok_or_else(|| EmbedError::Inference("empty batch result".into()))
    }

    /// Embed a batch of text snippets.  Returns one normalised `GOVERNED_DIM`-element
    /// vector per input, in the same order.
    pub fn embed_batch(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, EmbedError> {
        let encodings = self
            .tokenizer
            .encode_batch(texts.to_vec(), true)
            .map_err(|e| EmbedError::Tokenize(e.to_string()))?;

        let max_len = encodings
            .iter()
            .map(|e| e.get_ids().len())
            .max()
            .unwrap_or(0);
        let batch = texts.len();

        let mut input_ids_flat = Vec::with_capacity(batch * max_len);
        let mut attn_mask_flat = Vec::with_capacity(batch * max_len);
        let mut token_type_flat = Vec::with_capacity(batch * max_len);

        for enc in &encodings {
            let ids = enc.get_ids();
            let mask = enc.get_attention_mask();
            let len = ids.len();
            input_ids_flat.extend_from_slice(ids);
            input_ids_flat.extend(std::iter::repeat_n(0u32, max_len - len));
            attn_mask_flat.extend_from_slice(mask);
            attn_mask_flat.extend(std::iter::repeat_n(0u32, max_len - len));
            token_type_flat.extend(std::iter::repeat_n(0u32, max_len));
        }

        let shape = (batch, max_len);

        let input_ids = Tensor::from_vec(input_ids_flat, shape, &self.device)
            .map_err(EmbedError::from)?
            .to_dtype(DType::U32)
            .map_err(EmbedError::from)?;
        let attention_mask = Tensor::from_vec(attn_mask_flat, shape, &self.device)
            .map_err(EmbedError::from)?
            .to_dtype(DType::U32)
            .map_err(EmbedError::from)?;
        let token_type_ids = Tensor::from_vec(token_type_flat, shape, &self.device)
            .map_err(EmbedError::from)?
            .to_dtype(DType::U32)
            .map_err(EmbedError::from)?;

        let output = self
            .model
            .forward(&input_ids, &token_type_ids, Some(&attention_mask))
            .map_err(EmbedError::from)?;

        let pooled = mean_pool(&output, &attention_mask.to_dtype(output.dtype())?)
            .map_err(EmbedError::from)?;
        let normalized = l2_normalize(&pooled).map_err(EmbedError::from)?;

        // Convert to Vec<Vec<f32>>
        let data = normalized
            .to_dtype(DType::F32)
            .map_err(EmbedError::from)?
            .to_vec2::<f32>()
            .map_err(EmbedError::from)?;

        for (i, vec) in data.iter().enumerate() {
            if vec.len() != GOVERNED_DIM {
                return Err(EmbedError::DimensionMismatch {
                    got: vec.len(),
                    expected: GOVERNED_DIM,
                });
            }
            let _ = i;
        }

        Ok(data)
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Verify that [`GOVERNED_DIM`] matches what the governed model actually
    /// produces.  This test downloads model weights on first run (~80 MB).
    #[test]
    #[ignore = "downloads model weights from HuggingFace Hub"]
    fn embed_returns_governed_dimension() {
        let embedder = Embedder::new().expect("Embedder::new should succeed");
        let vec = embedder
            .embed_one("The quick brown fox jumps over the lazy dog.")
            .expect("embed_one should succeed");
        assert_eq!(
            vec.len(),
            GOVERNED_DIM,
            "embedding dimension mismatch: got {}, expected {}",
            vec.len(),
            GOVERNED_DIM
        );
    }

    /// Verify that identical input produces identical output across two calls
    /// (determinism within the same process).
    #[test]
    #[ignore = "downloads model weights from HuggingFace Hub"]
    fn embed_is_deterministic() {
        let embedder = Embedder::new().expect("Embedder::new should succeed");
        let text = "Superfield semantic search";

        let first = embedder
            .embed_one(text)
            .expect("first embed should succeed");
        let second = embedder
            .embed_one(text)
            .expect("second embed should succeed");

        assert_eq!(
            first, second,
            "embedding should be deterministic for the same input"
        );
    }

    /// Verify that a batch returns the correct number of vectors, each of
    /// length [`GOVERNED_DIM`].
    #[test]
    #[ignore = "downloads model weights from HuggingFace Hub"]
    fn embed_batch_returns_correct_count() {
        let embedder = Embedder::new().expect("Embedder::new should succeed");
        let texts = ["hello world", "goodbye world", "semantic search"];
        let results = embedder
            .embed_batch(&texts)
            .expect("embed_batch should succeed");

        assert_eq!(results.len(), texts.len());
        for vec in &results {
            assert_eq!(vec.len(), GOVERNED_DIM);
        }
    }
}
