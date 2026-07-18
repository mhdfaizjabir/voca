import os
from pymongo import MongoClient
from dotenv import load_dotenv

load_dotenv()  # if not already loaded

MONGO_URI = os.getenv("MONGODB_URI")
if not MONGO_URI:
    raise ValueError("MONGODB_URI not set in .env")

client = MongoClient(MONGO_URI)
db = client["company_research_db"]   # database name
research_collection = db["research"] # collection name