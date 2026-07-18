# test_mongo.py
from db import research_collection
print(research_collection.count_documents({}))