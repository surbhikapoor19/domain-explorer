"""LLM-based entity extraction from paper chunks.

Extracts text-derived entities (contributions, limitations, comparisons, etc.)
from chunks that have already been ingested and enriched with rhetorical roles.

Reads chunks from ChromaDB, calls the LLM for targeted extraction, and saves
structured entities to extracted_entities.json. Resumable: skips papers already
processed.

Usage:
    python -m backend.rag.ingest.llm_entity_extractor --config rag_config.yaml
"""

import json
import os
import re
import time
import logging
import argparse
import hashlib
from collections import defaultdict

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Entity type definitions
# ---------------------------------------------------------------------------

ENTITY_TYPES = {
    "contribution": {
        "description": "Key contribution or novel proposal made by the paper",
        "target_roles": {"algorithm_description", "problem_statement", "general"},
        "examples": "language-conditioned affordance prediction, SE(3)-equivariant grasp detection",
    },
    "novelty_claim": {
        "description": "Claim of being first, novel, or unlike prior work",
        "target_roles": {"algorithm_description", "problem_statement"},
        "examples": "first to combine diffusion models with 6-DoF grasp planning",
    },
    "methodology_step": {
        "description": "A concrete step in the proposed pipeline or algorithm",
        "target_roles": {"algorithm_description"},
        "examples": "encode point cloud with PointNet++, sample grasp candidates from learned distribution",
    },
    "comparison_claim": {
        "description": "Quantitative or qualitative comparison with another method",
        "target_roles": {"result", "comparison"},
        "examples": "outperforms Contact-GraspNet by 5.2% on GraspNet-1B",
    },
    "limitation": {
        "description": "Acknowledged limitation, failure case, or scope restriction",
        "target_roles": {"limitation", "general"},
        "examples": "does not handle transparent objects, requires known object models",
    },
    "problem_addressed": {
        "description": "The specific grasp planning problem or gap this paper addresses",
        "target_roles": {"problem_statement", "general"},
        "examples": "grasp planning in heavily cluttered bins, dexterous manipulation with partial observations",
    },
    "hardware_detail": {
        "description": "Specific robot arm, gripper, or sensor with model name",
        "target_roles": {"experimental_setup", "result"},
        "examples": "Franka Emika Panda with Robotiq 2F-85 gripper, Intel RealSense D435",
    },
    "quantitative_claim": {
        "description": "Specific numeric result with context",
        "target_roles": {"result"},
        "examples": "93.2% success rate on 50 novel objects in cluttered scenes",
    },
    "scene_description": {
        "description": "Types of objects, scenes, or configurations tested",
        "target_roles": {"experimental_setup", "result"},
        "examples": "pile of 10-30 unknown household objects, single known object on flat table",
    },
}

# Which roles trigger which entity types
ROLE_TO_TYPES = defaultdict(set)
for etype, spec in ENTITY_TYPES.items():
    for role in spec["target_roles"]:
        ROLE_TO_TYPES[role].add(etype)

# Also always extract from abstract chunks
ROLE_TO_TYPES["general"].update([
    "contribution", "problem_addressed", "limitation",
])


# ---------------------------------------------------------------------------
# LLM interaction
# ---------------------------------------------------------------------------

def _build_extraction_prompt(
    chunk_text: str,
    paper_id: str,
    section: str,
    rhetorical_role: str,
    target_types: list,
) -> list:
    """Build the chat messages for entity extraction."""
    type_descriptions = "\n".join(
        f'- "{t}": {ENTITY_TYPES[t]["description"]} (e.g., {ENTITY_TYPES[t]["examples"]})'
        for t in target_types
    )

    system_msg = (
        "You are a precise research paper analyst. Extract structured entities "
        "from academic text about robotic grasp planning. Return ONLY a JSON array. "
        "Be specific — use exact names, numbers, and method names from the text."
    )

    user_msg = f"""Extract entities from this paper excerpt.

Paper: {paper_id}
Section: {section}
Content type: {rhetorical_role}

Entity types to look for:
{type_descriptions}

TEXT:
{chunk_text}

Rules:
1. Extract ONLY entities actually stated in the text — do not infer or hallucinate.
2. Keep values close to the original wording (1-2 sentences max).
3. For comparison_claim, include the specific method name and metric if mentioned.
4. For hardware_detail, include model numbers when given.
5. Assign confidence: "high" if explicitly stated, "medium" if implied, "low" if uncertain.

Return a JSON array:
[{{"type": "...", "value": "...", "confidence": "high|medium|low"}}]

Return [] if no entities found. JSON only, no explanation."""

    return [
        {"role": "system", "content": system_msg},
        {"role": "user", "content": user_msg},
    ]


def _parse_llm_response(response: str) -> list:
    """Parse LLM response into a list of entity dicts."""
    # Try to extract JSON array from response
    response = response.strip()

    # Handle markdown code blocks
    if "```" in response:
        match = re.search(r'```(?:json)?\s*\n?(.*?)\n?```', response, re.DOTALL)
        if match:
            response = match.group(1).strip()

    # Handle cases where LLM wraps in extra text
    bracket_match = re.search(r'\[.*\]', response, re.DOTALL)
    if bracket_match:
        response = bracket_match.group(0)

    try:
        entities = json.loads(response)
        if not isinstance(entities, list):
            return []
        # Validate each entity
        valid = []
        for e in entities:
            if isinstance(e, dict) and "type" in e and "value" in e:
                if e["type"] in ENTITY_TYPES and len(e["value"]) > 5:
                    valid.append({
                        "type": e["type"],
                        "value": e["value"][:300],  # cap length
                        "confidence": e.get("confidence", "medium"),
                    })
        return valid
    except (json.JSONDecodeError, ValueError):
        logger.warning(f"Failed to parse LLM response: {response[:100]}...")
        return []


def _create_llm_fn(provider: str = "groq"):
    """Create a standalone LLM function (doesn't import app.py)."""
    if provider == "claude":
        api_key = os.environ.get("ANTHROPIC_API_KEY", "")
        if not api_key:
            raise ValueError("ANTHROPIC_API_KEY not set")
        import anthropic
        client = anthropic.Anthropic(api_key=api_key)

        def llm_fn(messages, max_tokens=1024, temperature=0.1):
            # Convert from OpenAI format to Anthropic format
            system_msg = ""
            user_msgs = []
            for m in messages:
                if m["role"] == "system":
                    system_msg = m["content"]
                else:
                    user_msgs.append(m)

            response = client.messages.create(
                model="claude-sonnet-4-20250514",
                max_tokens=max_tokens,
                system=system_msg if system_msg else "",
                messages=user_msgs,
                temperature=temperature,
            )
            return response.content[0].text.strip()
        return llm_fn

    elif provider == "groq":
        api_key = os.environ.get("GROQ_API_KEY", "")
        model = os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile")
        if not api_key:
            raise ValueError("GROQ_API_KEY not set")
        from groq import Groq
        client = Groq(api_key=api_key)

        def llm_fn(messages, max_tokens=1024, temperature=0.1):
            completion = client.chat.completions.create(
                model=model,
                messages=messages,
                max_tokens=max_tokens,
                temperature=temperature,
            )
            return completion.choices[0].message.content.strip()
        return llm_fn

    elif provider == "huggingface":
        token = os.environ.get("HF_API_TOKEN", os.environ.get("HF_TOKEN", ""))
        model = os.environ.get("AI_MODEL", "Qwen/Qwen2.5-72B-Instruct")
        if not token:
            raise ValueError("HF_API_TOKEN not set")
        from huggingface_hub import InferenceClient
        client = InferenceClient(token=token)

        def llm_fn(messages, max_tokens=1024, temperature=0.1):
            completion = client.chat_completion(
                model=model,
                messages=messages,
                max_tokens=max_tokens,
                temperature=temperature,
            )
            return completion.choices[0].message.content.strip()
        return llm_fn

    else:
        raise ValueError(f"Unsupported provider: {provider}")


# ---------------------------------------------------------------------------
# Extraction pipeline
# ---------------------------------------------------------------------------

def extract_entities_from_chunk(
    chunk_text: str,
    paper_id: str,
    section: str,
    rhetorical_role: str,
    chunk_id: str,
    llm_fn,
) -> list:
    """Extract entities from a single chunk via LLM.

    Returns list of dicts with type, value, confidence, paper_id, chunk_id, section.
    """
    # Determine which entity types to look for based on role
    target_types = list(ROLE_TO_TYPES.get(rhetorical_role, ROLE_TO_TYPES["general"]))
    if not target_types:
        return []

    # Skip very short chunks
    if len(chunk_text.split()) < 30:
        return []

    messages = _build_extraction_prompt(
        chunk_text=chunk_text[:3000],  # cap input to stay within context
        paper_id=paper_id,
        section=section,
        rhetorical_role=rhetorical_role,
        target_types=target_types,
    )

    try:
        response = llm_fn(messages, max_tokens=1024, temperature=0.1)
        entities = _parse_llm_response(response)
    except Exception as e:
        logger.warning(f"LLM call failed for {paper_id}/{chunk_id}: {e}")
        return []

    # Enrich with source metadata
    for entity in entities:
        entity["paper_id"] = paper_id
        entity["chunk_id"] = chunk_id
        entity["section"] = section
        entity["rhetorical_role"] = rhetorical_role

    return entities


def extract_entities_for_paper(
    paper_id: str,
    collection,
    llm_fn,
    delay: float = 2.0,
) -> list:
    """Extract entities from all relevant chunks of a paper.

    Reads chunks from ChromaDB, filters by rhetorical_role, calls LLM.
    """
    # Fetch all chunks for this paper
    results = collection.get(
        where={"paper_id": paper_id},
        include=["documents", "metadatas"],
    )

    if not results or not results.get("documents"):
        logger.warning(f"No chunks found for paper {paper_id}")
        return []

    all_entities = []
    chunks_processed = 0

    for doc, meta, chunk_id in zip(
        results["documents"],
        results["metadatas"],
        results["ids"],
    ):
        role = meta.get("rhetorical_role", "general")
        layer = meta.get("layer", "")
        section = meta.get("section", "")
        chunk_type = meta.get("chunk_type", "")

        # Only process relevant chunks:
        # 1. Abstract chunks (always valuable)
        # 2. Mid-layer chunks with matching rhetorical roles
        # 3. Skip fine chunks (too granular), skip coarse section summaries (redundant)
        should_process = False
        if chunk_type == "abstract":
            should_process = True
        elif layer == "mid" and role in ROLE_TO_TYPES:
            should_process = True

        if not should_process:
            continue

        entities = extract_entities_from_chunk(
            chunk_text=doc,
            paper_id=paper_id,
            section=section,
            rhetorical_role=role,
            chunk_id=chunk_id,
            llm_fn=llm_fn,
        )
        all_entities.extend(entities)
        chunks_processed += 1

        # Rate limiting
        if delay > 0:
            time.sleep(delay)

    logger.info(
        f"  {paper_id}: {chunks_processed} chunks -> {len(all_entities)} entities"
    )
    return all_entities


def run_entity_extraction(
    config_path: str,
    output_path: str = None,
    provider: str = "groq",
    delay: float = 2.0,
    papers: list = None,
) -> dict:
    """Run entity extraction across all papers.

    Reads chunks from ChromaDB (already ingested), extracts entities via LLM,
    saves to JSON. Resumable: skips papers already in output file.

    Args:
        config_path: Path to rag_config.yaml
        output_path: Where to save extracted_entities.json (default: chroma_db dir)
        provider: LLM provider ("groq" or "huggingface")
        delay: Seconds between LLM calls (rate limiting)
        papers: Optional list of paper_ids to process (default: all)

    Returns:
        Summary dict with stats.
    """
    from ..config import load_config
    from .store import get_client, create_or_get_collection

    config = load_config(config_path)
    if output_path is None:
        output_path = os.path.join(config.chroma_persist_dir, "extracted_entities.json")

    # Load existing progress
    existing = {}
    if os.path.exists(output_path):
        with open(output_path) as f:
            existing = json.load(f)
        print(f"Loaded {len(existing)} papers from existing file")

    # Connect to ChromaDB
    client = get_client(config)
    collection = create_or_get_collection(config, client)

    # Get all unique paper_ids from the collection
    all_meta = collection.get(include=["metadatas"])
    all_paper_ids = sorted(set(
        m.get("paper_id", "") for m in all_meta["metadatas"] if m.get("paper_id")
    ))

    if papers:
        all_paper_ids = [pid for pid in all_paper_ids if pid in papers]

    # Filter out already-processed papers
    todo = [pid for pid in all_paper_ids if pid not in existing]
    print(f"Papers in ChromaDB: {len(all_paper_ids)}")
    print(f"Already processed: {len(existing)}")
    print(f"To process: {len(todo)}")

    if not todo:
        print("All papers already processed!")
        return {"n_papers": 0, "n_entities": 0}

    # Create LLM function
    llm_fn = _create_llm_fn(provider)

    # Process each paper
    total_entities = 0
    errors = []

    for i, paper_id in enumerate(todo):
        print(f"\n[{i+1}/{len(todo)}] Extracting: {paper_id}")
        try:
            entities = extract_entities_for_paper(
                paper_id=paper_id,
                collection=collection,
                llm_fn=llm_fn,
                delay=delay,
            )
            existing[paper_id] = entities
            total_entities += len(entities)

            # Save after each paper (resumable)
            with open(output_path, "w") as f:
                json.dump(existing, f, indent=2)

            # Log entity type breakdown
            type_counts = defaultdict(int)
            for e in entities:
                type_counts[e["type"]] += 1
            breakdown = ", ".join(f"{k}={v}" for k, v in sorted(type_counts.items()))
            print(f"  -> {len(entities)} entities ({breakdown})")

        except Exception as e:
            error_msg = f"{paper_id}: {str(e)}"
            logger.error(error_msg)
            errors.append(error_msg)
            print(f"  ERROR: {error_msg}")
            # Still save progress
            with open(output_path, "w") as f:
                json.dump(existing, f, indent=2)

    print(f"\n{'='*60}")
    print(f"Extraction complete")
    print(f"  Papers processed: {len(todo)}")
    print(f"  Total entities: {total_entities}")
    print(f"  Errors: {len(errors)}")
    print(f"  Output: {output_path}")

    return {
        "n_papers": len(todo),
        "n_entities": total_entities,
        "errors": errors,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Extract text-derived entities from paper chunks using LLM"
    )
    parser.add_argument("--config", required=True, help="Path to rag_config.yaml")
    parser.add_argument("--output", default=None, help="Output JSON path")
    parser.add_argument("--provider", default="groq", choices=["groq", "huggingface", "claude"])
    parser.add_argument("--delay", type=float, default=2.0, help="Seconds between LLM calls")
    parser.add_argument("--papers", nargs="*", help="Specific paper IDs to process")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO)
    run_entity_extraction(
        config_path=args.config,
        output_path=args.output,
        provider=args.provider,
        delay=args.delay,
        papers=args.papers,
    )


if __name__ == "__main__":
    main()
