from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from db.local_store import create_document, get_document, list_documents
from rag.chunking import chunk_text
from rag.ingest import extract_text
from rag.pinecone_client import upsert_chunks

router = APIRouter(prefix="/documents", tags=["documents"])

ALLOWED_RESOURCE_TYPES = {"course_material", "job_description"}


class DocumentOut(BaseModel):
    id: str
    filename: str
    resource_type: str
    chunk_count: int


def _to_out(doc: dict) -> DocumentOut:
    return DocumentOut(
        id=doc["id"],
        filename=doc["filename"],
        resource_type=doc["resource_type"],
        chunk_count=doc["chunk_count"],
    )


@router.post("/upload", response_model=DocumentOut)
async def upload_document(
    file: UploadFile = File(...),
    resource_type: str = Form(...),
) -> DocumentOut:
    if resource_type not in ALLOWED_RESOURCE_TYPES:
        raise HTTPException(400, f"resource_type must be one of {sorted(ALLOWED_RESOURCE_TYPES)}")

    raw = await file.read()
    text = extract_text(raw, file.filename or "")
    if not text.strip():
        raise HTTPException(400, "Could not extract any text from the uploaded file")

    chunks = chunk_text(text)
    if not chunks:
        raise HTTPException(400, "Document produced no chunks")

    document_id = create_document(file.filename or "untitled", resource_type, len(chunks))
    upsert_chunks(document_id, chunks)

    return _to_out(get_document(document_id))


@router.get("", response_model=list[DocumentOut])
def get_documents() -> list[DocumentOut]:
    return [_to_out(doc) for doc in list_documents()]


@router.get("/{document_id}", response_model=DocumentOut)
def get_document_detail(document_id: str) -> DocumentOut:
    doc = get_document(document_id)
    if not doc:
        raise HTTPException(404, "Document not found")
    return _to_out(doc)
