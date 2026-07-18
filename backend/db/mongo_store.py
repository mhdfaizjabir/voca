import os
import json
import logging
from datetime import datetime, timezone
from pymongo import MongoClient, errors

logger = logging.getLogger(__name__)

# Get URI from environment
MONGO_URI = os.getenv("MONGODB_URI")
if not MONGO_URI:
    raise ValueError("MONGODB_URI not set in .env")

# Connect to MongoDB
client = MongoClient(MONGO_URI)
db = client["company_research_db"]          # database name
collection = db["research"]                 # collection name

# Create a compound index on (company, position) for fast lookups
try:
    collection.create_index([("company", 1), ("position", 1)], unique=False)
    logger.info("MongoDB index created on (company, position)")
except errors.OperationFailure as e:
    logger.warning("Index creation failed (maybe already exists): %s", e)

# Add TTL index to automatically delete documents after 30 days
try:
    collection.create_index("timestamp", expireAfterSeconds=3888000)  # 45 days
    logger.info("TTL index created on timestamp (45-day expiry)")
except errors.OperationFailure as e:
    logger.warning("TTL index creation failed: %s", e)

def get_company_research(company_name: str, position: str | None = None) -> dict | None:
    """
    Retrieve the most recent research document for a given company AND position.
    - If position is provided, it must match exactly (case‑sensitive).
    - If position is None, it looks for documents where position is None.
    Returns the document without the MongoDB _id field, or None if not found.
    """
    # Build the query – now includes position
    query = {"company": company_name}
    if position is not None:
        query["position"] = position
    else:
        query["position"] = None

    # Find the most recent document matching both fields
    doc = collection.find_one(query, sort=[("timestamp", -1)])
    if doc:
        doc.pop("_id", None)  # remove MongoDB's internal ID
        return doc
    return None


def save_company_research(company_name: str, research_json: str, source: str, confidence: float) -> None:
    """
    Save a research result to MongoDB.
    `research_json` is a JSON string that contains the full research dict.
    We parse it to extract position, summary, etc., and store them as separate fields.
    """
    try:
        data = json.loads(research_json) if isinstance(research_json, str) else research_json
    except Exception:
        # If parsing fails, treat it as a fallback/error – store as is
        data = {"summary": research_json, "source": source, "confidence": confidence}

    # Ensure we have the company and position fields
    data["company"] = company_name
    data["position"] = data.get("position")  # already present if parsed
    data["source"] = source
    data["confidence"] = confidence
    data["timestamp"] = datetime.now(timezone.utc)

    # Insert the document (we keep all versions for history)
    collection.insert_one(data)
    logger.info("Saved research for %s (position: %s)", company_name, data.get("position"))