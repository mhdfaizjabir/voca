import os
import json
import logging

from groq import Groq
from tavily import TavilyClient

from db.mongo_store import get_company_research, save_company_research

def _has_hedging(text: str) -> bool:
    """Return True if the text contains vague or generic phrasing."""
    hedge_phrases = [
        "generally",
        "most companies",
        "typically",
        "often",
        "in many cases",
        "common for",
        "usually",
        "a lot of",
        "many organizations",
        "some companies",
        "it depends",
    ]
    lower = text.lower()
    return any(phrase in lower for phrase in hedge_phrases)

logger = logging.getLogger(__name__)

def _clean_json(raw: str) -> str:
    """Remove markdown code fences and surrounding whitespace."""
    s = raw.strip()
    if s.startswith("```"):
        first_newline = s.find("\n")
        if first_newline != -1:
            s = s[first_newline + 1 :]
        else:
            s = s[3:]
    if s.endswith("```"):
        s = s[:-3]
    return s.strip()


# --------------------------------------------------------------------
#  Configuration – Qatar focus
# --------------------------------------------------------------------
REGION = "Qatar"
REGION_CONTEXT = (
    f"Focus exclusively on the company's presence, office culture, "
    f"interview process, and candidate experiences in {REGION}. "
    "If the company has no known presence in the region, say so clearly."
)

# --------------------------------------------------------------------
#  Tier 1: detailed parametric prompt (LLM)
# --------------------------------------------------------------------
TIER1_SYSTEM_PROMPT = """You are a helpful assistant that provides structured, detailed information about companies.
Always return ONLY valid JSON with the following keys:
- "company": the company name
- "position": the job role (if provided, else null)
- "summary": a 3-5 sentence summary that includes: typical interview stages, 1-2 common questions (if known), and key cultural values or traits the company looks for
- "confidence": a number from 0.0 to 1.0 indicating how certain you are of the information
- "source": "parametric"
- "region": the region you focused on
"Only provide information you are highly certain about, based on actual reports or common knowledge of that company's real interview practices. "
"If you do not have specific, concrete information for the company and position in the given region, set confidence below 0.4 and state that you lack details."
"""

TIER1_USER_PROMPT = (
    "What do you know about the real, reported interview process for the {position} position "
    "at {company} in {region}? Only include information you are certain is correct, based on "
    "actual candidate experiences or widely‑known facts about the company. "
    "If you don't have specific details, say so clearly and set confidence below 0.4. "
    "Never invent interview stages or questions."
)

# --------------------------------------------------------------------
#  Tier 2: web search queries (Tavily)
# --------------------------------------------------------------------
def _build_tier2_queries(company: str, position: str | None) -> list[str]:
    role = position or ""
    queries = [
        f"{company} interview culture {REGION} site:reddit.com",
        f"{company} interview questions {REGION} site:glassdoor.com",
        f"{company} culture {REGION} site:teamblind.com",
        f"{company} interview experience {REGION}",
    ]
    if role:
        queries.insert(0, f"{company} {role} interview process {REGION}")
        queries.insert(1, f"{company} {role} interview questions {REGION} site:glassdoor.com")
    return queries

# --------------------------------------------------------------------
#  Synthesis prompt (used after Tavily)
# --------------------------------------------------------------------
TIER2_SYNTHESIS_SYSTEM = """You are an expert analyst. Given the following search snippets about a company, 
synthesise them into a JSON object with these keys:
- "company": the company name
- "position": the job role (if provided, else null)
- "summary": a 3-5 sentence summary that includes: typical interview stages, 1-2 common questions (if known), and key cultural values or traits the company looks for, based on the search results
- "confidence": a number 0.0-1.0 indicating how reliable the synthesis is
- "source": "web_search"
- "region": the region
Return ONLY the JSON object, no other text."""

TIER2_SYNTHESIS_USER = (
    "Company: {company}\nPosition: {position}\nRegion: {region}\n\nSearch results:\n{results}\n\n"
    "Synthesise the above into a detailed, specific summary about the interview process for the position at this company in the region."
)

# --------------------------------------------------------------------
#  Clients (lazy initialised)
# --------------------------------------------------------------------
_groq_client = None
_tavily_client = None


def _get_groq():
    global _groq_client
    if _groq_client is None:
        _groq_client = Groq(api_key=os.environ["GROQ_API_KEY"])
    return _groq_client


def _get_tavily():
    global _tavily_client
    if _tavily_client is None:
        _tavily_client = TavilyClient(api_key=os.environ["TAVILY_API_KEY"])
    return _tavily_client


# --------------------------------------------------------------------
#  Core lookup function
# --------------------------------------------------------------------
async def get_company_context(company_name: str, position: str | None = None) -> dict:
    """
    Returns a research dict with keys: company, position, summary, confidence, source, region.
    """
    # Tier 0: cache (currently caches by company name only)
    cached = get_company_research(company_name, position)
    if cached:
        logger.info("Company cache hit for %s (position: %s)", company_name, position)
        return cached

    # Tier 1: parametric
    try:
        result = await _tier1_parametric(company_name, position)
        if result and result.get("confidence", 0) >= 0.4:
            summary = result.get("summary", "")
            # If the summary is vague, force fallback to Tavily
            if _has_hedging(summary):
                logger.info("Tier1 summary is vague – forcing fallback to web search")
                raise Exception("Vague summary – fallback triggered")
            save_company_research(
                company_name,
                json.dumps(result),
                "parametric",
                result["confidence"],
            )
            return result
    except Exception as e:
        logger.warning("Tier1 failed or was vague: %s", e)

    # Tier 2: web search + synthesis
    try:
        result = await _tier2_search(company_name, position)
        if result:
            save_company_research(
                company_name,
                json.dumps(result),
                "web_search",
                result.get("confidence", 0.0),
            )
            return result
    except Exception as e:
        logger.warning("Tier2 failed for %s: %s", company_name, e)

    # Fallback
    fallback = {
        "company": company_name,
        "position": position,
        "summary": f"No detailed information found about {company_name} interviews"
        + (f" for the {position} role" if position else "")
        + f" in {REGION}.",
        "confidence": 0.0,
        "source": "fallback",
        "region": REGION,
    }
    save_company_research(
        company_name,
        json.dumps(fallback),
        "fallback",
        0.0,
    )
    return fallback


async def _tier1_parametric(company: str, position: str | None) -> dict:
    groq = _get_groq()
    prompt = TIER1_USER_PROMPT.format(
        company=company, region=REGION, position=position or "not specified"
    )
    response = groq.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[
            {"role": "system", "content": TIER1_SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ],
        temperature=0.3,
        max_tokens=400,
    )
    content = response.choices[0].message.content.strip()
    try:
        data = json.loads(_clean_json(content))
        data["region"] = REGION
        data["position"] = position
        return data
    except json.JSONDecodeError:
        logger.warning("Tier1 LLM did not return valid JSON: %s", content)
        return None


async def _tier2_search(company: str, position: str | None) -> dict:
    tavily = _get_tavily()
    queries = _build_tier2_queries(company, position)
    all_snippets = []
    for query in queries:
        try:
            response = tavily.search(query, max_results=3)
            if response.get("results"):
                snippets = [r.get("content", "") for r in response["results"]]
                all_snippets.extend(snippets)
        except Exception as e:
            logger.warning("Tavily query failed for '%s': %s", query, e)

    if not all_snippets:
        return None

    unique = list(dict.fromkeys(all_snippets))
    combined = "\n\n".join(unique)[:3000]

    groq = _get_groq()
    synth_prompt = TIER2_SYNTHESIS_USER.format(
        company=company, position=position or "any", region=REGION, results=combined
    )
    synth_resp = groq.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[
            {"role": "system", "content": TIER2_SYNTHESIS_SYSTEM},
            {"role": "user", "content": synth_prompt},
        ],
        temperature=0.3,
        max_tokens=400,
    )
    content = synth_resp.choices[0].message.content.strip()
    try:
        data = json.loads(_clean_json(content))
        data["region"] = REGION
        data["position"] = position
        return data
    except json.JSONDecodeError:
        logger.warning("Tier2 synthesis did not return valid JSON: %s", content)
        return None