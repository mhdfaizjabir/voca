import os

from pinecone import EmbedConfig, IntegratedSpec, Pinecone
from pinecone.index import Index

INDEX_NAME = "voca-documents"
EMBED_MODEL = "multilingual-e5-large"
TEXT_FIELD = "chunk_text"
UPSERT_BATCH_SIZE = 90  # stay under Pinecone's per-request records/payload limits

_pc: Pinecone | None = None
_index: Index | None = None


def get_client() -> Pinecone:
    global _pc
    if _pc is None:
        _pc = Pinecone(api_key=os.environ["PINECONE_API_KEY"])
    return _pc


def get_index() -> Index:
    global _index
    if _index is not None:
        return _index

    pc = get_client()
    if not pc.indexes.exists(INDEX_NAME):
        pc.indexes.create(
            name=INDEX_NAME,
            spec=IntegratedSpec(
                cloud=os.environ.get("PINECONE_CLOUD", "aws"),
                region=os.environ.get("PINECONE_REGION", "us-east-1"),
                embed=EmbedConfig(model=EMBED_MODEL, field_map={"text": TEXT_FIELD}),
            ),
        )

    _index = pc.index(name=INDEX_NAME)
    return _index


def upsert_chunks(namespace: str, chunks: list[str]) -> None:
    index = get_index()
    for start in range(0, len(chunks), UPSERT_BATCH_SIZE):
        batch = chunks[start : start + UPSERT_BATCH_SIZE]
        records = [
            {"_id": f"{namespace}-{start + i}", TEXT_FIELD: chunk} for i, chunk in enumerate(batch)
        ]
        index.upsert_records(namespace=namespace, records=records)
