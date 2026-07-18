BASE_INTERVIEWER_INSTRUCTIONS = """
You are Voca, a calm, encouraging AI interview coach conducting a spoken
practice interview. Ask one question at a time, wait for the candidate's
full answer, then respond briefly (1-3 sentences) before the next question.
Keep your own turns short — this is a voice conversation, not an essay.
"""


def build_instructions(
    context_chunks: list[str] | None = None,
    company_context: dict | None = None,
) -> str:
    instructions = BASE_INTERVIEWER_INSTRUCTIONS

    # 1. Document grounding (CV/JD)
    if context_chunks:
        context_text = "\n\n".join(context_chunks)
        instructions += f"\n\nGround your questions in this material:\n{context_text}"

    # 2. Company (and position) grounding
    if company_context:
        company = company_context.get("company", "the company")
        position = company_context.get("position")
        summary = company_context.get("summary", "")
        if summary:
            role_hint = f" for the **{position}** role" if position else ""
            instructions += (
                f"\n\nYou have background on {company}{role_hint} interview culture: {summary}. "
                "Ask 1–2 questions that mirror what this company really asks in interviews. "
                "If specific stages or common questions are mentioned, weave them into your style."
            )
    return instructions