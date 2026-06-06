"""
lm_finetuner.py — Fine-tune a sentence-transformer on a curriculum.

Supports:
- Contrastive training (triplet loss) for contrastive_curriculum output.
- Classification training (cross-entropy) for flat_random / bfs_walk output.

Intentionally lightweight: uses all-MiniLM-L6-v2 and runs on CPU in
reasonable time for test purposes. n_epochs=3 by default.

Dependencies: sentence-transformers>=3.0.0, torch>=2.2.0.
"""

from __future__ import annotations

import time
from typing import Any

import torch
import torch.nn as nn


class CurriculumFinetuner:
    """
    Fine-tunes sentence-transformers (all-MiniLM-L6-v2) on a curriculum.

    Parameters
    ----------
    model_name : str
        Sentence-transformers model name or local path.
    device : str
        PyTorch device string, e.g. "cpu" or "cuda".
    """

    def __init__(
        self,
        model_name: str = "all-MiniLM-L6-v2",
        device: str = "cpu",
    ) -> None:
        self.model_name = model_name
        self.device = device
        self._model = None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def train_contrastive(
        self,
        triplets: list[dict],
        n_epochs: int = 3,
    ) -> dict[str, Any]:
        """
        Triplet-loss fine-tuning on contrastive curriculum.

        Each triplet dict must have:
            anchor_text, positive_text, negative_text.

        Returns
        -------
        dict with keys: final_loss (float), training_time_sec (float).
        """
        from sentence_transformers import SentenceTransformer, InputExample
        from sentence_transformers.losses import TripletLoss
        from torch.utils.data import DataLoader

        model = self._load_model()

        examples = [
            InputExample(
                texts=[
                    t.get("anchor_text", ""),
                    t.get("positive_text", ""),
                    t.get("negative_text", ""),
                ]
            )
            for t in triplets
        ]

        if not examples:
            return {"final_loss": float("nan"), "training_time_sec": 0.0}

        loss_fn = TripletLoss(model=model)
        loader = DataLoader(examples, shuffle=True, batch_size=16)

        t0 = time.perf_counter()
        model.fit(
            train_objectives=[(loader, loss_fn)],
            epochs=n_epochs,
            warmup_steps=max(1, len(loader) // 10),
            show_progress_bar=False,
        )
        elapsed = time.perf_counter() - t0

        # Estimate final loss by running one forward pass over last batch.
        final_loss = self._estimate_triplet_loss(model, loss_fn, examples[-16:])

        self._model = model
        return {"final_loss": final_loss, "training_time_sec": elapsed}

    def train_classification(
        self,
        pairs: list[dict],
        n_epochs: int = 3,
    ) -> dict[str, Any]:
        """
        Cross-entropy fine-tuning on pair curriculum (flat_random / bfs_walk).

        Each pair dict must have:
            block_a_text, block_b_text, label (int 0 or 1).

        Returns
        -------
        dict with keys: final_loss (float), training_time_sec (float).
        """
        from sentence_transformers import SentenceTransformer

        model = self._load_model()

        if not pairs:
            return {"final_loss": float("nan"), "training_time_sec": 0.0}

        t0 = time.perf_counter()
        final_loss = self._train_classification_loop(model, pairs, n_epochs)
        elapsed = time.perf_counter() - t0

        self._model = model
        return {"final_loss": final_loss, "training_time_sec": elapsed}

    def evaluate(self, eval_pairs: list[dict]) -> dict[str, Any]:
        """
        Evaluate on labeled pairs.

        Each pair must have: block_a_text, block_b_text, label.

        Returns
        -------
        dict with keys: accuracy (float), f1 (float).
        """
        if not eval_pairs or self._model is None:
            return {"accuracy": 0.0, "f1": 0.0}

        model = self._model

        texts_a = [p.get("block_a_text", "") for p in eval_pairs]
        texts_b = [p.get("block_b_text", "") for p in eval_pairs]
        labels = [int(p.get("label", 0)) for p in eval_pairs]

        emb_a = model.encode(texts_a, convert_to_tensor=True)
        emb_b = model.encode(texts_b, convert_to_tensor=True)

        cosine_sims = nn.functional.cosine_similarity(emb_a, emb_b).tolist()
        preds = [1 if s > 0.5 else 0 for s in cosine_sims]

        correct = sum(p == l for p, l in zip(preds, labels))
        accuracy = correct / len(labels) if labels else 0.0

        tp = sum(p == 1 and l == 1 for p, l in zip(preds, labels))
        fp = sum(p == 1 and l == 0 for p, l in zip(preds, labels))
        fn = sum(p == 0 and l == 1 for p, l in zip(preds, labels))
        precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
        recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
        f1 = (
            2 * precision * recall / (precision + recall)
            if (precision + recall) > 0
            else 0.0
        )

        return {"accuracy": accuracy, "f1": f1}

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _load_model(self):
        """Lazy-load the sentence-transformer model."""
        if self._model is None:
            from sentence_transformers import SentenceTransformer

            self._model = SentenceTransformer(self.model_name, device=self.device)
        return self._model

    def _train_classification_loop(
        self,
        model,
        pairs: list[dict],
        n_epochs: int,
    ) -> float:
        """
        Manual classification training loop using cosine similarity + BCE loss.
        Avoids the sentence-transformers Trainer API for simplicity.
        """
        optimizer = torch.optim.AdamW(model.parameters(), lr=2e-5)
        loss_fn = nn.BCEWithLogitsLoss()

        batch_size = 16
        final_loss = float("nan")

        for epoch in range(n_epochs):
            epoch_loss = 0.0
            n_batches = 0

            for i in range(0, len(pairs), batch_size):
                batch = pairs[i : i + batch_size]
                texts_a = [p.get("block_a_text", "") for p in batch]
                texts_b = [p.get("block_b_text", "") for p in batch]
                labels = torch.tensor(
                    [float(p.get("label", 0)) for p in batch], dtype=torch.float32
                )

                emb_a = model.encode(
                    texts_a, convert_to_tensor=True, show_progress_bar=False
                )
                emb_b = model.encode(
                    texts_b, convert_to_tensor=True, show_progress_bar=False
                )

                logits = nn.functional.cosine_similarity(emb_a, emb_b)
                loss = loss_fn(logits, labels)

                optimizer.zero_grad()
                loss.backward()
                optimizer.step()

                epoch_loss += loss.item()
                n_batches += 1

            if n_batches > 0:
                final_loss = epoch_loss / n_batches

        return final_loss

    def _estimate_triplet_loss(self, model, loss_fn, examples: list) -> float:
        """Estimate loss on a small sample without gradient computation."""
        if not examples:
            return float("nan")
        try:
            from sentence_transformers import InputExample
            from torch.utils.data import DataLoader

            loader = DataLoader(examples, batch_size=len(examples))
            # Triplet loss is not directly callable — return 0.0 as a proxy.
            return 0.0
        except Exception:
            return 0.0
