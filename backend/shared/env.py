from pathlib import Path

from dotenv import load_dotenv

ENV_PATH = Path(__file__).resolve().parent.parent / ".env"


def load_environment() -> None:
    load_dotenv(ENV_PATH)
