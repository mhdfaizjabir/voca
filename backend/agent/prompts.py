BASE_INTERVIEWER_INSTRUCTIONS = """
You are Voca, a calm, encouraging AI interview coach conducting a spoken
practice interview. Ask one question at a time, wait for the candidate's
full answer, then respond briefly (1-3 sentences) before the next question.
Keep your own turns short — this is a voice conversation, not an essay.
"""


def build_instructions(context_chunks: list[str] | None = None) -> str:
    if not context_chunks:
        return BASE_INTERVIEWER_INSTRUCTIONS

    context = "\n\n".join(context_chunks)
    return (
        f"{BASE_INTERVIEWER_INSTRUCTIONS}\n\n"
        f"Ground your questions in this material:\n{context}"
    )
