#!/usr/bin/env python3
"""Bounded offline semantic retrieval and join-candidate experiment.

The harness deliberately has no product imports or network path. Learned
similarity produces ranked candidates; fixed judgments and source evidence
produce evaluation labels. Nothing in this module authorizes a rendered link.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sqlite3
import statistics
import time
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
CORPUS_PATH = HERE / "corpus.json"
QUERIES_PATH = HERE / "queries.json"
MANIFEST_PATH = HERE / "source_manifest.json"
JUDGMENTS_PATH = HERE / "join_judgments.json"
RECEIPTS_DIR = HERE / "receipts"
RAW_DIR = ROOT / "warehouse" / "raw" / "semantic-layer-trial"
INDEX_PATH = RAW_DIR / "semantic-index.sqlite"

MODEL_ID = "sentence-transformers/all-MiniLM-L6-v2"
MODEL_REVISION_PARTS = ("1110a243fdf4706b3f48", "f1d95db1a4f5529b4d41")
MODEL_REVISION = "".join(MODEL_REVISION_PARTS)
EMBEDDING_DIMENSIONS = 384
CHUNK_CHARS = 1_200
CHUNK_OVERLAP = 200
TOP_K = 5
SEMANTIC_CANDIDATE_THRESHOLD = 0.45
JOIN_USEFULNESS_THRESHOLD = 0.30
RRF_K = 60

WORD_RE = re.compile(r"[a-z0-9][a-z0-9'-]{1,40}")
STOP_WORDS = {
    "a", "an", "and", "are", "as", "at", "be", "by", "did", "do", "does",
    "for", "from", "how", "in", "is", "it", "must", "of", "on", "or", "that",
    "the", "their", "this", "to", "under", "was", "were", "what", "when", "where",
    "which", "who", "with", "would", "about", "can", "city", "new", "public", "rules",
}


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(65_536), b""):
            digest.update(block)
    return digest.hexdigest()


def tokens(value: str) -> list[str]:
    return [token for token in WORD_RE.findall(str(value).lower()) if token not in STOP_WORDS]


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, math.ceil(fraction * len(ordered)) - 1))
    return ordered[index]


def iso_elapsed_seconds(start: str, finish: str) -> float:
    return (
        datetime.fromisoformat(finish.replace("Z", "+00:00"))
        - datetime.fromisoformat(start.replace("Z", "+00:00"))
    ).total_seconds()


def chunk_documents(documents: list[dict[str, Any]]) -> list[dict[str, Any]]:
    chunks: list[dict[str, Any]] = []
    for document in documents:
        text = str(document.get("text") or "")
        start = 0
        index = 0
        while start < len(text):
            end = min(len(text), start + CHUNK_CHARS)
            body = text[start:end]
            chunks.append(
                {
                    "chunk_id": len(chunks) + 1,
                    "document_id": document["id"],
                    "chunk_index": index,
                    "text": f"{document.get('title') or ''}\n{body}",
                }
            )
            if end >= len(text):
                break
            start = max(start + 1, end - CHUNK_OVERLAP)
            index += 1
    return chunks


class BM25:
    def __init__(self, documents: list[dict[str, Any]]) -> None:
        self.ids = [str(document["id"]) for document in documents]
        self.rows = [tokens(f"{document.get('title', '')} {document.get('text', '')}") for document in documents]
        self.term_frequencies = [Counter(row) for row in self.rows]
        self.lengths = [len(row) for row in self.rows]
        self.average_length = statistics.fmean(self.lengths) if self.lengths else 0.0
        self.document_frequency: Counter[str] = Counter()
        for row in self.rows:
            self.document_frequency.update(set(row))

    def ranked(self, query: str) -> list[tuple[str, float]]:
        query_tokens = tokens(query)
        count = len(self.rows)
        scored: list[tuple[str, float]] = []
        for document_id, frequencies, length in zip(self.ids, self.term_frequencies, self.lengths):
            score = 0.0
            for term in query_tokens:
                frequency = frequencies.get(term, 0)
                if not frequency:
                    continue
                document_frequency = self.document_frequency[term]
                inverse = math.log(1 + (count - document_frequency + 0.5) / (document_frequency + 0.5))
                denominator = frequency + 1.2 * (1 - 0.75 + 0.75 * length / max(1.0, self.average_length))
                score += inverse * (frequency * 2.2) / denominator
            if score > 0:
                scored.append((document_id, score))
        return sorted(scored, key=lambda item: (-item[1], item[0]))


def token_and_ranked(documents: list[dict[str, Any]], query: str) -> list[tuple[str, float]]:
    query_tokens = tokens(query)
    ranked = []
    for document in documents:
        document_tokens = set(tokens(f"{document.get('title', '')} {document.get('text', '')}"))
        if query_tokens and all(term in document_tokens for term in query_tokens):
            ranked.append((str(document["id"]), float(len(query_tokens))))
    return sorted(ranked, key=lambda item: (-item[1], item[0]))


def reciprocal_rank_fusion(*rankings: list[tuple[str, float]]) -> list[tuple[str, float]]:
    scores: Counter[str] = Counter()
    for ranking in rankings:
        for rank, (document_id, _score) in enumerate(ranking, start=1):
            scores[document_id] += 1.0 / (RRF_K + rank)
    return sorted(scores.items(), key=lambda item: (-item[1], item[0]))


def load_optional_dependencies() -> tuple[Any, Any, Any]:
    try:
        import numpy as np
        import sentence_transformers
        import sqlite_vec
    except ImportError as error:
        raise SystemExit(
            "offline trial dependencies are missing; install the experiment requirements.txt"
        ) from error
    return np, sentence_transformers, sqlite_vec


def open_vector_index(sqlite_vec: Any, dimensions: int) -> sqlite3.Connection:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    if INDEX_PATH.exists():
        INDEX_PATH.unlink()
    connection = sqlite3.connect(INDEX_PATH)
    connection.enable_load_extension(True)
    sqlite_vec.load(connection)
    connection.enable_load_extension(False)
    connection.execute(
        "CREATE VIRTUAL TABLE vec_chunks USING vec0("
        "chunk_id INTEGER PRIMARY KEY, embedding FLOAT[%d] distance_metric=cosine)" % dimensions
    )
    return connection


def semantic_ranked(
    connection: sqlite3.Connection,
    sqlite_vec: Any,
    query_vector: Any,
    chunk_by_id: dict[int, dict[str, Any]],
    candidate_chunks: int,
) -> list[tuple[str, float]]:
    rows = connection.execute(
        "SELECT chunk_id, distance FROM vec_chunks WHERE embedding MATCH ? AND k = ?",
        [sqlite_vec.serialize_float32(query_vector), candidate_chunks],
    ).fetchall()
    by_document: dict[str, float] = {}
    for chunk_id, distance in rows:
        document_id = chunk_by_id[int(chunk_id)]["document_id"]
        similarity = 1.0 - float(distance)
        by_document[document_id] = max(by_document.get(document_id, -1.0), similarity)
    return sorted(by_document.items(), key=lambda item: (-item[1], item[0]))


def judged_results(
    method: str,
    ranking: list[tuple[str, float]],
    relevant: set[str],
    documents_by_id: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    output = []
    for rank, (document_id, score) in enumerate(ranking[:TOP_K], start=1):
        document = documents_by_id[document_id]
        output.append(
            {
                "rank": rank,
                "document_id": document_id,
                "title": document.get("title"),
                "kind": document.get("kind"),
                "score": round(float(score), 6),
                "relevant": document_id in relevant,
                "honest_label": "retrieval_candidate",
                "method": method,
            }
        )
    return output


def aggregate_metrics(per_query: list[dict[str, Any]], method: str) -> dict[str, Any]:
    precision = []
    recall = []
    reciprocal_rank = []
    for row in per_query:
        results = row["methods"][method]
        relevant_count = len(row["relevant"])
        hits = sum(1 for result in results if result["relevant"])
        precision.append(hits / TOP_K)
        recall.append(hits / relevant_count if relevant_count else 0.0)
        first = next((result["rank"] for result in results if result["relevant"]), None)
        reciprocal_rank.append(1.0 / first if first else 0.0)
    return {
        "queries": len(per_query),
        "precision_at_5_macro": round(statistics.fmean(precision), 4),
        "recall_at_5_macro": round(statistics.fmean(recall), 4),
        "mrr_at_5": round(statistics.fmean(reciprocal_rank), 4),
        "queries_with_relevant_at_5": sum(value > 0 for value in recall),
        "precision_denominator": "5 even when a method returns fewer than five candidates",
    }


def evaluate_join_candidates(
    manifest: dict[str, Any],
    judgments: dict[str, Any],
    documents_by_id: dict[str, dict[str, Any]],
    chunks: list[dict[str, Any]],
    chunk_vectors: Any,
) -> dict[str, Any]:
    vectors_by_document: dict[str, list[Any]] = {}
    for chunk, vector in zip(chunks, chunk_vectors):
        vectors_by_document.setdefault(chunk["document_id"], []).append(vector)
    outcome_documents = [row for row in documents_by_id.values() if row.get("kind") == "community_board_minutes"]
    judgment_by_pair = {
        (row["notice_id"], row["document_id"]): row for row in judgments["judgments"]
    }
    candidates = []
    structurally_eligible = 0
    for residual in manifest["non_council_residual"]:
        notice = documents_by_id[str(residual["request_id"])]
        for outcome in outcome_documents:
            if outcome.get("body_id") != residual.get("body_id"):
                continue
            if outcome.get("event_date") != residual.get("event_date"):
                continue
            structurally_eligible += 1
            similarity = max(
                float(left @ right)
                for left in vectors_by_document[notice["id"]]
                for right in vectors_by_document[outcome["id"]]
            )
            if similarity < SEMANTIC_CANDIDATE_THRESHOLD:
                continue
            judgment = judgment_by_pair.get((notice["id"], outcome["id"]))
            candidates.append(
                {
                    "notice_id": notice["id"],
                    "document_id": outcome["id"],
                    "semantic_score": round(similarity, 6),
                    "honest_label": "join_candidate_only",
                    "review_disposition": judgment.get("disposition") if judgment else "unreviewed",
                    "review_evidence": judgment.get("evidence") if judgment else None,
                    "production_edge_authorized": False,
                }
            )
    accepted = [row for row in candidates if row["review_disposition"] == "accepted_candidate"]
    review_seconds = iso_elapsed_seconds(
        judgments["review_started_at"], judgments["review_finished_at"]
    )
    return {
        "schema": "cityscroll.semantic_layer_trial.join_review_receipt.v1",
        "observed_on": "2026-08-04",
        "honest_label": "Semantic output is a candidate queue, never a factual edge.",
        "residual": {
            "name": "dated non-Council notice-to-minutes residual",
            "baseline_joined": 0,
            "baseline_total": len(manifest["non_council_residual"]),
            "baseline_receipt": "site/data/non_council_outcome_sources/verification_receipts/non_council_minutes_votes_2026-08-04.json",
        },
        "candidate_generation": {
            "structural_blockers_before_similarity": ["exact_body_id", "exact_meeting_date"],
            "semantic_threshold": SEMANTIC_CANDIDATE_THRESHOLD,
            "structurally_eligible_pairs": structurally_eligible,
            "candidates_proposed": len(candidates),
            "candidates_surviving_review": len(accepted),
            "accepted_candidate_rate_over_residual": round(
                len(accepted) / len(manifest["non_council_residual"]), 4
            ),
            "usefulness_threshold": JOIN_USEFULNESS_THRESHOLD,
            "clears_usefulness_threshold": (
                len(accepted) / len(manifest["non_council_residual"])
                >= JOIN_USEFULNESS_THRESHOLD
            ),
        },
        "review_cost": {
            "review_seconds": review_seconds,
            "accepted_candidates": len(accepted),
            "seconds_per_accepted_candidate": (
                round(review_seconds / len(accepted), 2) if accepted else None
            ),
        },
        "candidates": candidates,
        "production_wiring": False,
    }


def decide(retrieval: dict[str, Any], join_receipt: dict[str, Any]) -> dict[str, Any]:
    metrics = retrieval["metrics"]
    join_passes = join_receipt["candidate_generation"]["clears_usefulness_threshold"]
    # The learned layer must add successful reader intents beyond a ranked
    # lexical baseline. Beating the deliberately strict current token matcher
    # is not enough to justify a model and vector store.
    retrieval_uplift = (
        metrics["hybrid_rrf"]["queries_with_relevant_at_5"]
        > metrics["bm25"]["queries_with_relevant_at_5"]
    )
    if join_passes and retrieval_uplift:
        hook = "adopt-both"
    elif join_passes:
        hook = "adopt-candidate-generator"
    elif retrieval_uplift:
        hook = "adopt-related-reading-only"
    else:
        hook = "not-worth-it"
    return {
        "schema": "cityscroll.semantic_layer_trial.decision.v1",
        "observed_on": "2026-08-04",
        "decision_hook": hook,
        "production_wiring_in_trial": False,
        "reasons": {
            "hybrid_precision_at_5": metrics["hybrid_rrf"]["precision_at_5_macro"],
            "current_token_precision_at_5": metrics["token_and"]["precision_at_5_macro"],
            "bm25_precision_at_5": metrics["bm25"]["precision_at_5_macro"],
            "semantic_precision_at_5": metrics["semantic"]["precision_at_5_macro"],
            "hybrid_precision_delta_vs_bm25": round(
                metrics["hybrid_rrf"]["precision_at_5_macro"]
                - metrics["bm25"]["precision_at_5_macro"],
                4,
            ),
            "hybrid_additional_queries_with_relevant_at_5_vs_bm25": (
                metrics["hybrid_rrf"]["queries_with_relevant_at_5"]
                - metrics["bm25"]["queries_with_relevant_at_5"]
            ),
            "join_candidates_surviving_review": join_receipt["candidate_generation"]["candidates_surviving_review"],
            "join_residual_total": join_receipt["residual"]["baseline_total"],
            "join_clears_usefulness_threshold": join_passes,
        },
        "follow_on": (
            "Improve ranked lexical retrieval first and keep the existing precomputed related-reading path. "
            "Re-run a learned-embedding trial only after a larger labeled corpus names a missed reader journey. "
            "Do not add semantic join edges from this trial; the join-candidate yield remains below the existing gate."
        ),
    }


def validate_receipts() -> None:
    expected = {
        "retrieval_review.json": "cityscroll.semantic_layer_trial.retrieval_review.v1",
        "join_candidate_review.json": "cityscroll.semantic_layer_trial.join_review_receipt.v1",
        "costs.json": "cityscroll.semantic_layer_trial.costs.v1",
        "decision.json": "cityscroll.semantic_layer_trial.decision.v1",
    }
    for filename, schema in expected.items():
        path = RECEIPTS_DIR / filename
        if not path.exists():
            raise SystemExit(f"missing semantic trial receipt: {path.relative_to(ROOT)}")
        document = read_json(path)
        if document.get("schema") != schema:
            raise SystemExit(f"semantic trial receipt schema mismatch: {filename}")
    retrieval = read_json(RECEIPTS_DIR / "retrieval_review.json")
    if retrieval.get("query_count") != 30:
        raise SystemExit("semantic trial retrieval receipt must retain 30 fixed queries")
    if retrieval.get("corpus", {}).get("corpus_sha256") != sha256_file(CORPUS_PATH):
        raise SystemExit("semantic trial corpus changed after the retrieval review")
    if retrieval.get("corpus", {}).get("queries_sha256") != sha256_file(QUERIES_PATH):
        raise SystemExit("semantic trial judgments changed after the retrieval review")
    corpus = read_json(CORPUS_PATH)
    if retrieval.get("corpus", {}).get("documents") != corpus.get("document_count"):
        raise SystemExit("semantic trial document count does not match its receipt")
    join_receipt = read_json(RECEIPTS_DIR / "join_candidate_review.json")
    if join_receipt.get("production_wiring") is not False:
        raise SystemExit("semantic trial must not authorize production join wiring")
    if any(row.get("honest_label") != "join_candidate_only" for row in join_receipt["candidates"]):
        raise SystemExit("semantic trial join rows must remain labeled candidates")
    decision = read_json(RECEIPTS_DIR / "decision.json")
    allowed = {
        "adopt-candidate-generator", "adopt-related-reading-only", "adopt-both", "not-worth-it"
    }
    if decision.get("decision_hook") not in allowed:
        raise SystemExit("semantic trial decision hook is invalid")
    if decision.get("production_wiring_in_trial") is not False:
        raise SystemExit("semantic trial decision must not authorize production wiring")
    print("semantic layer trial receipts ok")


def run() -> None:
    np, sentence_transformers, sqlite_vec = load_optional_dependencies()
    corpus = read_json(CORPUS_PATH)
    query_document = read_json(QUERIES_PATH)
    manifest = read_json(MANIFEST_PATH)
    judgments = read_json(JUDGMENTS_PATH)
    documents = corpus["documents"]
    documents_by_id = {str(row["id"]): row for row in documents}
    chunks = chunk_documents(documents)
    chunk_by_id = {row["chunk_id"]: row for row in chunks}

    process_started = time.process_time()
    load_started = time.perf_counter()
    model = sentence_transformers.SentenceTransformer(
        MODEL_ID,
        revision=MODEL_REVISION,
        local_files_only=True,
        device="cpu",
    )
    model_load_ms = (time.perf_counter() - load_started) * 1000
    dimensions = int(model.get_embedding_dimension())
    if dimensions != EMBEDDING_DIMENSIONS:
        raise SystemExit(f"model dimension drift: expected {EMBEDDING_DIMENSIONS}, got {dimensions}")

    embed_started = time.perf_counter()
    chunk_vectors = model.encode_document(
        [row["text"] for row in chunks],
        normalize_embeddings=True,
        convert_to_numpy=True,
        batch_size=32,
        show_progress_bar=False,
    ).astype(np.float32)
    document_embedding_ms = (time.perf_counter() - embed_started) * 1000

    index_started = time.perf_counter()
    connection = open_vector_index(sqlite_vec, dimensions)
    connection.executemany(
        "INSERT INTO vec_chunks(chunk_id, embedding) VALUES (?, ?)",
        [
            (row["chunk_id"], sqlite_vec.serialize_float32(vector))
            for row, vector in zip(chunks, chunk_vectors)
        ],
    )
    connection.commit()
    index_build_ms = (time.perf_counter() - index_started) * 1000
    index_bytes = INDEX_PATH.stat().st_size

    bm25 = BM25(documents)
    query_vectors = model.encode_query(
        [row["text"] for row in query_document["queries"]],
        normalize_embeddings=True,
        convert_to_numpy=True,
        batch_size=32,
        show_progress_bar=False,
    ).astype(np.float32)

    per_query = []
    candidate_chunks = min(len(chunks), 100)
    methods = ["token_and", "bm25", "semantic", "hybrid_rrf"]
    for query, query_vector in zip(query_document["queries"], query_vectors):
        token_ranking = token_and_ranked(documents, query["text"])
        bm25_ranking = bm25.ranked(query["text"])
        semantic_ranking = semantic_ranked(
            connection, sqlite_vec, query_vector, chunk_by_id, candidate_chunks
        )
        hybrid_ranking = reciprocal_rank_fusion(bm25_ranking, semantic_ranking)
        relevant = set(query["relevant"])
        per_query.append(
            {
                "query_id": query["id"],
                "query": query["text"],
                "relevant": query["relevant"],
                "judgment_basis": query["basis"],
                "methods": {
                    "token_and": judged_results("token_and", token_ranking, relevant, documents_by_id),
                    "bm25": judged_results("bm25", bm25_ranking, relevant, documents_by_id),
                    "semantic": judged_results("semantic", semantic_ranking, relevant, documents_by_id),
                    "hybrid_rrf": judged_results("hybrid_rrf", hybrid_ranking, relevant, documents_by_id),
                },
            }
        )

    retrieval_receipt = {
        "schema": "cityscroll.semantic_layer_trial.retrieval_review.v1",
        "observed_on": "2026-08-04",
        "honest_label": "Every ranked row is a retrieval candidate judged against fixed qrels.",
        "corpus": {
            "documents": len(documents),
            "chunks": len(chunks),
            "corpus_sha256": sha256_file(CORPUS_PATH),
            "queries_sha256": sha256_file(QUERIES_PATH),
        },
        "query_count": len(per_query),
        "k": TOP_K,
        "methods": {
            "token_and": "AND over non-stopword query tokens; emulates the current substring-token constraint.",
            "bm25": "Local lexical ranking over the same fixed text.",
            "semantic": "Chunked MiniLM cosine KNN through sqlite-vec; document score is its best passage.",
            "hybrid_rrf": "Reciprocal-rank fusion of BM25 and semantic rankings.",
        },
        "metrics": {method: aggregate_metrics(per_query, method) for method in methods},
        "queries": per_query,
    }
    write_json(RECEIPTS_DIR / "retrieval_review.json", retrieval_receipt)

    join_receipt = evaluate_join_candidates(
        manifest, judgments, documents_by_id, chunks, chunk_vectors
    )
    write_json(RECEIPTS_DIR / "join_candidate_review.json", join_receipt)

    latency: dict[str, list[float]] = {
        "query_embedding_ms": [], "vector_knn_ms": [], "bm25_ms": [], "hybrid_total_ms": []
    }
    for _repeat in range(3):
        for query in query_document["queries"]:
            started = time.perf_counter()
            query_vector = model.encode_query(
                query["text"],
                normalize_embeddings=True,
                convert_to_numpy=True,
                show_progress_bar=False,
            ).astype(np.float32)
            embed_ms = (time.perf_counter() - started) * 1000
            latency["query_embedding_ms"].append(embed_ms)
            started = time.perf_counter()
            semantic_ranking = semantic_ranked(
                connection, sqlite_vec, query_vector, chunk_by_id, candidate_chunks
            )
            vector_ms = (time.perf_counter() - started) * 1000
            latency["vector_knn_ms"].append(vector_ms)
            started = time.perf_counter()
            bm25_ranking = bm25.ranked(query["text"])
            bm25_ms = (time.perf_counter() - started) * 1000
            latency["bm25_ms"].append(bm25_ms)
            started = time.perf_counter()
            reciprocal_rank_fusion(bm25_ranking, semantic_ranking)
            fusion_ms = (time.perf_counter() - started) * 1000
            latency["hybrid_total_ms"].append(embed_ms + vector_ms + bm25_ms + fusion_ms)

    refresh_chunk = chunks[0]
    refresh_started = time.perf_counter()
    refresh_vector = model.encode_document(
        refresh_chunk["text"],
        normalize_embeddings=True,
        convert_to_numpy=True,
        show_progress_bar=False,
    ).astype(np.float32)
    refresh_embed_ms = (time.perf_counter() - refresh_started) * 1000
    refresh_started = time.perf_counter()
    connection.execute("DELETE FROM vec_chunks WHERE chunk_id = ?", [refresh_chunk["chunk_id"]])
    connection.execute(
        "INSERT INTO vec_chunks(chunk_id, embedding) VALUES (?, ?)",
        [refresh_chunk["chunk_id"], sqlite_vec.serialize_float32(refresh_vector)],
    )
    connection.commit()
    refresh_index_ms = (time.perf_counter() - refresh_started) * 1000

    model_cache = (
        Path.home()
        / ".cache"
        / "huggingface"
        / "hub"
        / "models--sentence-transformers--all-MiniLM-L6-v2"
    )
    # Count content-addressed blobs only; snapshot symlinks point to the same
    # bytes and must not double-count disk storage.
    model_cache_bytes = sum(
        path.stat().st_size for path in (model_cache / "blobs").rglob("*") if path.is_file()
    )
    costs_receipt = {
        "schema": "cityscroll.semantic_layer_trial.costs.v1",
        "observed_on": "2026-08-04",
        "mode": "offline_cpu_build_and_local_sqlite_query",
        "model": {
            "id": MODEL_ID,
            "revision_parts": list(MODEL_REVISION_PARTS),
            "sentence_transformers_version": sentence_transformers.__version__,
            "dimensions_measured": dimensions,
            "max_sequence_length_measured": int(model.max_seq_length),
            "cache_bytes_measured": model_cache_bytes,
        },
        "build": {
            "documents": len(documents),
            "chunks": len(chunks),
            "model_load_ms": round(model_load_ms, 2),
            "document_embedding_ms": round(document_embedding_ms, 2),
            "sqlite_index_build_ms": round(index_build_ms, 2),
            "process_cpu_seconds_total": round(time.process_time() - process_started, 3),
            "metered_api_calls": 0,
            "metered_cost_usd": 0,
        },
        "storage": {
            "corpus_bytes": CORPUS_PATH.stat().st_size,
            "float32_vector_payload_bytes": int(chunk_vectors.size * 4),
            "sqlite_index_bytes": index_bytes,
        },
        "warm_query_latency": {
            name: {
                "samples": len(values),
                "p50_ms": round(percentile(values, 0.50), 3),
                "p95_ms": round(percentile(values, 0.95), 3),
            }
            for name, values in latency.items()
        },
        "single_chunk_refresh": {
            "embedding_ms": round(refresh_embed_ms, 3),
            "delete_insert_commit_ms": round(refresh_index_ms, 3),
            "mechanic": "Re-embed changed chunks and replace their rows; unchanged vectors remain intact.",
        },
        "not_measured": [
            "Cloudflare Vectorize query latency",
            "Workers AI embedding latency or billing",
            "production corpus growth",
            "cross-encoder reranking",
        ],
    }
    write_json(RECEIPTS_DIR / "costs.json", costs_receipt)
    write_json(RECEIPTS_DIR / "decision.json", decide(retrieval_receipt, join_receipt))
    connection.close()
    validate_receipts()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="validate committed receipts only")
    args = parser.parse_args()
    if args.check:
        validate_receipts()
    else:
        run()


if __name__ == "__main__":
    main()
