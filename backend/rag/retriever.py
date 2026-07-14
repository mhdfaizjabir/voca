from rag.pinecone_client import TEXT_FIELD, get_index

# Course notes and job descriptions are single documents scoped to their own
# Pinecone namespace, so a broad seed query is enough to pull back the most
# generally relevant chunks to ground an interview's opening questions.
SEED_QUERY = "key topics, skills, responsibilities, and important concepts"


def retrieve(document_id: str, query: str = SEED_QUERY, top_k: int = 8) -> list[str]:
    index = get_index()
    response = index.search(
        namespace=document_id,
        top_k=top_k,
        inputs={"text": query},
        fields=[TEXT_FIELD],
    )
    return [hit.fields[TEXT_FIELD] for hit in response.result.hits]
