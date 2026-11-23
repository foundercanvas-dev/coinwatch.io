import logging
import os
from pathlib import Path
from typing import Optional

from app.storage.database import Database
from app.storage.repository import SignalRepository


logger = logging.getLogger("storage")
_repository: Optional[SignalRepository] = None
_initialized = False


def get_signal_repository() -> Optional[SignalRepository]:
    global _repository, _initialized
    if _initialized:
        return _repository
    _initialized = True
    try:
        default_path = Path(__file__).resolve().parents[2] / "data" / "coinwatch.db"
        database = Database(os.getenv("DATABASE_PATH", str(default_path)))
        database.migrate()
        _repository = SignalRepository(database)
    except Exception as error:
        logger.error("Signal persistence unavailable; continuing in memory: %s", error)
        _repository = None
    return _repository
