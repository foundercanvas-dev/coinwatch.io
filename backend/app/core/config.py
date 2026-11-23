from pydantic_settings import BaseSettings
from typing import List, Optional
import os

class Settings(BaseSettings):
    PROJECT_NAME: str = "Perp Scanner 2.0"
    VERSION: str = "2.0.0"
    HOST: str = "0.0.0.0"
    PORT: int = 8000
    
    # Exchange Priorities & Endpoints
    EXCHANGES_ENABLED: List[str] = ["hyperliquid", "binance", "bybit", "okx"]
    
    # Hyperliquid
    HYPERLIQUID_WS_URL: str = "wss://api.hyperliquid.xyz/ws"
    HYPERLIQUID_INFO_URL: str = "https://api.hyperliquid.xyz/info"
    
    # Binance Futures
    BINANCE_FUTURES_WS: str = "wss://fstream.binance.com/ws"
    BINANCE_FUTURES_REST: str = "https://fapi.binance.com"
    
    # Bybit Linear
    BYBIT_WS_URL: str = "wss://stream.bybit.com/v5/public/linear"
    BYBIT_REST_URL: str = "https://api.bybit.com/v5"

    # OKX USDT perpetual swaps
    OKX_WS_URL: str = "wss://ws.okx.com:8443/ws/v5/public"
    OKX_REST_URL: str = "https://www.okx.com/api/v5"

    # Ingestion & Accuracy Guardrails
    MIN_24H_VOLUME_USD: float = 500_000.0  # Ingest the UI's lowest supported turnover tier
    MAX_SYMBOLS_PER_EXCHANGE: int = 100
    CANDLE_WINDOW_SIZE: int = 60            # 60 candles (1h rolling window)
    
    # Alert & Cooldown Settings
    COOLDOWN_SECONDS: int = 900             # 15 minutes per-symbol cooldown
    MIN_COMPOSITE_SCORE_ALERT: float = 75.0 # Min score to fire alert
    
    # Telegram Bot
    TELEGRAM_BOT_TOKEN: Optional[str] = os.getenv("TELEGRAM_BOT_TOKEN", "")
    TELEGRAM_CHAT_ID: Optional[str] = os.getenv("TELEGRAM_CHAT_ID", "")
    
    # Storage
    DATA_DIR: str = os.path.join(os.path.dirname(__file__), "..", "..", "data")
    DATABASE_PATH: str = os.path.join(DATA_DIR, "coinwatch.db")

    def model_post_init(self, __context) -> None:
        # Older Make environments may still override the pre-OKX three-feed list.
        if "okx" not in self.EXCHANGES_ENABLED:
            self.EXCHANGES_ENABLED = [*self.EXCHANGES_ENABLED, "okx"]

    class Config:
        env_file = ".env"
        extra = "ignore"

settings = Settings()
