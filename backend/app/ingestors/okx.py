import asyncio
import logging
import time
from collections import defaultdict
from typing import Dict, List, Set, Tuple

import aiohttp
import orjson
import websockets

from app.core.config import settings
from app.core.models import Candle
from app.core.ring_buffer import market_store
from app.ingestors.base import BaseExchangeIngestor


logger = logging.getLogger("ingestor.okx")


class OkxIngestor(BaseExchangeIngestor):
    """Public OKX USDT perpetual ticker, candle, and trade streams."""

    def __init__(self):
        super().__init__("okx")
        self.session: aiohttp.ClientSession = None
        self.tracked_instruments: Dict[str, str] = {}
        self._ws_task: asyncio.Task = None
        self._trade_counts: Dict[Tuple[str, int], int] = defaultdict(int)

    @staticmethod
    def _symbol(inst_id: str) -> str:
        return inst_id.replace("-USDT-SWAP", "USDT").replace("-", "")

    async def fetch_top_symbols(self):
        url = f"{settings.OKX_REST_URL}/market/tickers?instType=SWAP"
        try:
            async with self.session.get(url, timeout=aiohttp.ClientTimeout(total=10)) as response:
                payload = await response.json()
            qualifying: List[Tuple[str, str, float]] = []
            for item in payload.get("data", []):
                inst_id = item.get("instId", "")
                if not inst_id.endswith("-USDT-SWAP"):
                    continue
                symbol = self._symbol(inst_id)
                price = float(item.get("last") or 0)
                turnover = float(item.get("volCcy24h") or 0) * price
                open_24h = float(item.get("open24h") or 0)
                buffer = market_store.get_or_create(self.exchange_name, symbol)
                buffer.update_price(price, turnover)
                if open_24h > 0:
                    buffer.price_change_24h = ((price - open_24h) / open_24h) * 100
                if turnover >= settings.MIN_24H_VOLUME_USD:
                    qualifying.append((inst_id, symbol, turnover))

            qualifying.sort(key=lambda row: row[2], reverse=True)
            selected = qualifying[: settings.MAX_SYMBOLS_PER_EXCHANGE]
            self.tracked_instruments = {inst_id: symbol for inst_id, symbol, _ in selected}
            await asyncio.gather(
                *(self._backfill(inst_id, symbol) for inst_id, symbol, _ in selected[:30])
            )
            logger.info("[OKX] Loaded %s top liquid USDT perpetual swaps", len(selected))
        except Exception as error:
            logger.error("[OKX] Error fetching tickers: %s", error)

    async def _backfill(self, inst_id: str, symbol: str):
        url = f"{settings.OKX_REST_URL}/market/candles?instId={inst_id}&bar=1m&limit=100"
        try:
            async with self.session.get(url, timeout=aiohttp.ClientTimeout(total=5)) as response:
                payload = await response.json()
            buffer = market_store.get_or_create(self.exchange_name, symbol)
            for row in reversed(payload.get("data", [])):
                buffer.add_candle(
                    Candle(
                        exchange=self.exchange_name,
                        symbol=symbol,
                        canonical=f"{symbol.replace('USDT', '')}-PERP",
                        tf="1m",
                        open=float(row[1]),
                        high=float(row[2]),
                        low=float(row[3]),
                        close=float(row[4]),
                        volume=float(row[5]),
                        quote_volume=float(row[7]),
                        trades_count=None,
                        closed=row[8] == "1",
                        ts=int(row[0]),
                    )
                )
        except Exception:
            return

    async def _ws_consumer_loop(self):
        while self.is_running:
            try:
                async with websockets.connect(
                    settings.OKX_WS_URL, ping_interval=20, ping_timeout=10
                ) as websocket:
                    args = []
                    for inst_id in list(self.tracked_instruments)[:40]:
                        args.extend(
                            [
                                {"channel": "tickers", "instId": inst_id},
                                {"channel": "candle1m", "instId": inst_id},
                                {"channel": "trades", "instId": inst_id},
                            ]
                        )
                    for index in range(0, len(args), 50):
                        await websocket.send(
                            orjson.dumps({"op": "subscribe", "args": args[index : index + 50]}).decode()
                        )
                        await asyncio.sleep(0.1)
                    logger.info("[OKX] Connected to public perpetual WebSocket.")

                    async for message in websocket:
                        if not self.is_running:
                            break
                        payload = orjson.loads(message)
                        channel = payload.get("arg", {}).get("channel", "")
                        inst_id = payload.get("arg", {}).get("instId", "")
                        symbol = self.tracked_instruments.get(inst_id)
                        if not symbol:
                            continue
                        if channel == "tickers":
                            for item in payload.get("data", []):
                                price = float(item.get("last") or 0)
                                turnover = float(item.get("volCcy24h") or 0) * price
                                open_24h = float(item.get("open24h") or 0)
                                buffer = market_store.get_or_create(self.exchange_name, symbol)
                                buffer.update_price(price, turnover, int(item.get("ts") or time.time() * 1000))
                                if open_24h > 0:
                                    buffer.price_change_24h = ((price - open_24h) / open_24h) * 100
                        elif channel == "trades":
                            for trade in payload.get("data", []):
                                minute = (int(trade["ts"]) // 60_000) * 60_000
                                self._trade_counts[(symbol, minute)] += 1
                        elif channel == "candle1m":
                            for row in payload.get("data", []):
                                candle_ts = int(row[0])
                                buffer = market_store.get_or_create(self.exchange_name, symbol)
                                buffer.add_candle(
                                    Candle(
                                        exchange=self.exchange_name,
                                        symbol=symbol,
                                        canonical=f"{symbol.replace('USDT', '')}-PERP",
                                        tf="1m",
                                        open=float(row[1]),
                                        high=float(row[2]),
                                        low=float(row[3]),
                                        close=float(row[4]),
                                        volume=float(row[5]),
                                        quote_volume=float(row[7]),
                                        trades_count=self._trade_counts.get((symbol, candle_ts)),
                                        closed=row[8] == "1",
                                        ts=candle_ts,
                                    )
                                )
            except Exception as error:
                logger.warning("[OKX] WS disconnected: %s. Reconnecting in 3s...", error)
                await asyncio.sleep(3)

    async def start(self):
        self.is_running = True
        self.session = aiohttp.ClientSession()
        await self.fetch_top_symbols()
        self._ws_task = asyncio.create_task(self._ws_consumer_loop())
        logger.info("[OKX] Ingestor started successfully.")

    async def stop(self):
        self.is_running = False
        if self._ws_task:
            self._ws_task.cancel()
        if self.session:
            await self.session.close()
        logger.info("[OKX] Ingestor stopped.")
