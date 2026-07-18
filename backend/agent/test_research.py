#!/usr/bin/env python
"""
Test script for company research pipeline.
This is a dev tool to verify tiered research and caching.
"""
import sys
from pathlib import Path

# ── Step 1: Add parent directory to path so we can import our modules ──
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# ── Step 2: Load environment variables BEFORE any other imports ──
from shared.env import load_environment
load_environment()  # This loads .env from the backend folder

# ── Step 3: Now import everything else ──
import asyncio
import logging
from research.company_research import get_company_context

# Set up logging to see cache hits, etc.
logging.basicConfig(level=logging.INFO)


async def main():
    print("\n" + "=" * 60)
    print("Company Research Tester (MongoDB cache enabled)")
    print("=" * 60)
    company = input("Enter company name (e.g., Accenture): ").strip()
    if not company:
        print("Company name required.")
        return
    position = input("Enter position (optional, press Enter to skip): ").strip()
    if not position:
        position = None

    print(f"\n🔍 Researching: {company}" + (f" for {position}" if position else ""))
    print("-" * 60)

    result = await get_company_context(company, position)

    print("\n📊 Result:")
    print(f"  Source:     {result.get('source', 'unknown')}")
    print(f"  Confidence: {result.get('confidence', 0.0):.2f}")
    print(f"  Position:   {result.get('position', 'N/A')}")
    print("\n📝 Summary:")
    print(result.get('summary', 'No summary available.'))
    print("\n" + "=" * 60)


if __name__ == "__main__":
    asyncio.run(main())