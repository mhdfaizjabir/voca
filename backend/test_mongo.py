# test_mongo.py
from shared.env import load_environment
load_environment()

from db.mongo_store import collection as research_collection
print(research_collection.count_documents({}))