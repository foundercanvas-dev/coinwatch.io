from fastapi import APIRouter, HTTPException, Query, Body
from fastapi.responses import JSONResponse
from pydantic import BaseModel as PydanticBaseModel
from typing import List, Optional, Dict, Any
import asyncio
import httpx
import time
import uuid

from app.core.ring_buffer import market_store
from app.core.models import ScannerRow, PlanOfAttack, POAStatus, BiasType
from app.engine.signals import evaluate_signals_for_buffer, calculate_poa_levels
from app.engine.correlation import correlation_engine
from app.engine.composite import calculate_composite_score
from app.engine.status import classify_signal_status
from app.core.feed import feed_store
from app.core.watchlist import watchlist_store
from app.core.config import settings
from app.engine.policy import SENSITIVITY_POLICY, policy_payload, timeframe_minutes

router = APIRouter()


@router.get("/scanner/policy")
async def get_scanner_policy():
    """Returns the authoritative scanner policy used by backend and frontend."""
    return policy_payload()


# In-memory POA store
poa_db: Dict[str, PlanOfAttack] = {}

def build_scanner_row_for_buffer(buf) -> ScannerRow:
    bias, flow, breakdown = evaluate_signals_for_buffer(buf)
    
    # Check BTC decoupling
    _, is_decoupled = correlation_engine.check_btc_decoupling(buf)
    breakdown.is_decoupled = is_decoupled
    
    score = calculate_composite_score(breakdown)
    
    current_px = buf.latest_tick_price or (buf.candles[-1].close if buf.candles else 0.0)
    canonical = f"{buf.symbol.replace('USDT', '')}-PERP"

    return ScannerRow(
        symbol=buf.symbol,
        canonical=canonical,
        exchange=buf.exchange,
        price=current_px,
        price_change_1m=buf.get_price_change_pct(1),
        price_change_5m=buf.get_price_change_pct(5),
        price_change_15m=buf.get_price_change_pct(15),
        price_change_1h=buf.get_price_change_pct(60),
        price_change_24h=buf.price_change_24h,
        volume_24h_usd=buf.volume_24h_usd,
        volume_spike_ratio=breakdown.volume_spike_ratio,
        open_interest_usd=buf.open_interest_usd,
        oi_change_5m=breakdown.oi_change_5m,
        oi_change_1h=breakdown.oi_change_1h,
        funding_rate=buf.funding_rate,
        flow_quadrant=flow,
        bias=bias,
        composite_score=score,
        breakdown=breakdown,
        signal_status=classify_signal_status(buf),
        last_update_ts=buf.last_tick_ts_ms or int(time.time() * 1000)
    )

from app.engine.pump_dump_tracker import pump_dump_tracker

@router.get("/pump-dump/stats")
async def get_pump_dump_stats(
    sensitivity: float = Query(0.8),
    timeframe: str = Query("1m"),
    min_liquidity: float = Query(0.0, ge=0.0),
):
    """Returns the 6 stats cards matching the live scanner UI for selected timeframe."""
    now_ms = int(time.time() * 1000)
    stale_after_ms = max(30_000, timeframe_minutes(timeframe) * 3 * 60_000)
    buffers = [
        b for b in market_store.get_all_buffers()
        if b.last_tick_ts_ms and now_ms - b.last_tick_ts_ms <= stale_after_ms
    ]
    total_monitored = len([b for b in buffers if b.latest_tick_price > 0 or b.candles])

    # Scan buffers for moves on this timeframe
    for b in buffers:
        if min_liquidity > 0 and b.volume_24h_usd < min_liquidity:
            continue
        pump_dump_tracker.add_signal_from_buffer(
            b,
            sensitivity=float(SENSITIVITY_POLICY["detection_floor_pct"]),
            timeframe=timeframe,
        )

    result = pump_dump_tracker.get_stats(
        sensitivity=sensitivity,
        total_monitored=total_monitored,
        timeframe=timeframe,
    )
    result["eligible"] = len([
        b for b in buffers
        if (min_liquidity <= 0 or b.volume_24h_usd >= min_liquidity) and (b.latest_tick_price > 0 or b.candles)
    ])
    live_exchanges = {
        b.exchange
        for b in buffers
        if b.last_tick_ts_ms and now_ms - b.last_tick_ts_ms <= 30_000
    }
    result["stream_batches"] = f"{len(live_exchanges)} / {len(settings.EXCHANGES_ENABLED)}"
    recent_ticks = [b.last_tick_ts_ms for b in buffers if b.last_tick_ts_ms]
    result["last_tick_age_ms"] = (
        max(0, now_ms - max(recent_ticks)) if recent_ticks else None
    )
    return result

@router.get("/pump-dump/signals")
async def get_pump_dump_signals(
    sensitivity: float = Query(0.8),
    view: str = Query("live"),
    timeframe: str = Query("1m"),
    min_liquidity: float = Query(0.0, ge=0.0),
):
    """Returns live or historical confirmed pump/dump signal cards for selected timeframe."""
    # Scan active buffers with confirmation criteria
    now_ms = int(time.time() * 1000)
    stale_after_ms = max(30_000, timeframe_minutes(timeframe) * 3 * 60_000)
    for b in market_store.get_all_buffers():
        if not b.last_tick_ts_ms or now_ms - b.last_tick_ts_ms > stale_after_ms:
            continue
        if min_liquidity > 0 and b.volume_24h_usd < min_liquidity:
            continue
        pump_dump_tracker.add_signal_from_buffer(
            b,
            sensitivity=float(SENSITIVITY_POLICY["detection_floor_pct"]),
            timeframe=timeframe,
        )

    return [
        signal
        for signal in pump_dump_tracker.get_signals(
            sensitivity=sensitivity, view=view, timeframe=timeframe
        )
        if min_liquidity <= 0 or float(signal.get("turnover_24h_usd", 0)) >= min_liquidity
    ]

@router.get("/scanner/snapshot", response_model=List[ScannerRow])
async def get_scanner_snapshot(
    exchange: Optional[str] = Query(None, description="hyperliquid, binance, bybit, or all"),
    min_volume: Optional[float] = Query(0.0),
    sort_by: Optional[str] = Query("composite_score")
):
    """Returns the current market scan table snapshot."""
    rows: List[ScannerRow] = []
    now_ms = int(time.time() * 1000)
    
    for buf in market_store.get_all_buffers():
        if not buf.last_tick_ts_ms or now_ms - buf.last_tick_ts_ms > 30_000:
            continue
        if exchange and exchange != "all" and buf.exchange.lower() != exchange.lower():
            continue
        if buf.volume_24h_usd < min_volume:
            continue
        if buf.latest_tick_price <= 0 and not buf.candles:
            continue
            
        row = build_scanner_row_for_buffer(buf)
        rows.append(row)

    # Sorting
    if sort_by == "composite_score":
        rows.sort(key=lambda r: r.composite_score, reverse=True)
    elif sort_by == "volume_spike":
        rows.sort(key=lambda r: r.volume_spike_ratio, reverse=True)
    elif sort_by == "oi_change":
        rows.sort(key=lambda r: abs(r.oi_change_5m), reverse=True)
    elif sort_by == "volume_24h":
        rows.sort(key=lambda r: r.volume_24h_usd, reverse=True)

    return rows

@router.get("/chart/{exchange}/{symbol}/candles")
async def get_chart_candles(exchange: str, symbol: str, interval: str = Query("1m")):
    """Returns recent candles for TradingView lightweight charts with multi-timeframe aggregation."""
    key = f"{exchange.lower()}:{symbol.upper()}"
    buf = market_store.buffers.get(key)
    
    if not buf:
        return {"candles": [], "markers": [], "poa_levels": None, "current_price": 0.0, "interval": interval}

    candles_data = buf.get_aggregated_candles(interval=interval)

    # Calculate suggested POA levels
    bias, flow, breakdown = evaluate_signals_for_buffer(buf)
    current_px = buf.latest_tick_price or (buf.candles[-1].close if buf.candles else 0.0)
    
    high = current_px * 1.01
    low = current_px * 0.99
    if buf.candles:
        high = max(c.high for c in list(buf.candles)[-10:])
        low = min(c.low for c in list(buf.candles)[-10:])
        
    poa_levels = calculate_poa_levels(current_px, bias, high, low, timeframe=interval)

    # Signal markers for chart
    markers = []
    if breakdown.volume_spike_ratio >= 2.0 and candles_data:
        last_t = candles_data[-1]["time"]
        is_long = "LONG" in bias.value
        markers.append({
            "time": last_t,
            "position": "belowBar" if is_long else "aboveBar",
            "color": "#00F5A0" if is_long else "#FF3B69",
            "shape": "arrowUp" if is_long else "arrowDown",
            "text": f"{bias.value} ({interval.upper()})"
        })

    return {
        "candles": candles_data,
        "markers": markers,
        "poa_levels": poa_levels,
        "current_price": current_px,
        "interval": interval
    }

@router.get("/poa", response_model=List[PlanOfAttack])
async def list_poas():
    """List all saved Plan of Attack trade setups."""
    return list(poa_db.values())

@router.post("/poa", response_model=PlanOfAttack)
async def create_poa(poa: PlanOfAttack):
    """Save or arm a new Plan of Attack."""
    if not poa.id:
        poa.id = str(uuid.uuid4())[:8]
    poa.updated_at = int(time.time() * 1000)
    poa_db[poa.id] = poa
    return poa

@router.patch("/poa/{poa_id}/status")
async def update_poa_status(poa_id: str, status: POAStatus, outcome_r: Optional[float] = None):
    if poa_id not in poa_db:
        raise HTTPException(status_code=404, detail="POA not found")
    poa = poa_db[poa_id]
    poa.status = status
    if outcome_r is not None:
        poa.outcome_r = outcome_r
    poa.updated_at = int(time.time() * 1000)
    return poa

@router.post("/poa/size")
async def calculate_position_size(
    account_size: float,
    risk_pct: float,
    entry_price: float,
    stop_loss: float
):
    """Calculates exact contract size, position dollar value, and margin required."""
    if entry_price <= 0 or stop_loss <= 0 or entry_price == stop_loss:
        raise HTTPException(status_code=400, detail="Invalid price parameters")

    risk_amount = account_size * (risk_pct / 100.0)
    price_distance_pct = abs(entry_price - stop_loss) / entry_price
    
    position_size_usd = risk_amount / price_distance_pct
    contracts = position_size_usd / entry_price
    
    suggested_leverage = min(20, max(2, int(1.0 / price_distance_pct)))
    margin_required = position_size_usd / suggested_leverage

    return {
        "risk_amount_usd": round(risk_amount, 2),
        "price_distance_pct": round(price_distance_pct * 100, 2),
        "position_size_usd": round(position_size_usd, 2),
        "contracts": round(contracts, 4),
        "suggested_leverage": suggested_leverage,
        "margin_required_usd": round(margin_required, 2)
    }

# ── Feed Events ──────────────────────────────────────────────────────────

@router.get("/feed")
async def get_feed(
    since_id: int = Query(0),
    limit: int = Query(50, ge=1, le=200),
):
    """Returns recent feed events."""
    return feed_store.get_events(since_id=since_id, limit=limit)


# ── Watchlist ────────────────────────────────────────────────────────────

class WatchlistAddBody(PydanticBaseModel):
    symbol: str
    exchange: str
    alert_threshold: float = 3.0

@router.get("/watchlist")
async def get_watchlist():
    return watchlist_store.get_watchlist()

@router.post("/watchlist")
async def add_watchlist(body: WatchlistAddBody):
    return watchlist_store.add_to_watchlist(body.symbol, body.exchange, body.alert_threshold)

@router.delete("/watchlist/{exchange}/{symbol}")
async def remove_watchlist(exchange: str, symbol: str):
    removed = watchlist_store.remove_from_watchlist(symbol, exchange)
    if not removed:
        raise HTTPException(status_code=404, detail="Symbol not in watchlist")
    return {"ok": True}

@router.post("/watchlist/{exchange}/{symbol}/toggle")
async def toggle_watchlist_armed(exchange: str, symbol: str):
    entry = watchlist_store.toggle_armed(symbol, exchange)
    if entry is None:
        raise HTTPException(status_code=404, detail="Symbol not in watchlist")
    return entry


# ── Favorites ────────────────────────────────────────────────────────────

class FavoriteBody(PydanticBaseModel):
    symbol: str
    exchange: str

@router.get("/favorites")
async def get_favorites():
    return watchlist_store.get_favorites()

@router.post("/favorites")
async def add_favorite(body: FavoriteBody):
    return watchlist_store.add_favorite(body.symbol, body.exchange)

@router.delete("/favorites/{exchange}/{symbol}")
async def remove_favorite(exchange: str, symbol: str):
    removed = watchlist_store.remove_favorite(symbol, exchange)
    if not removed:
        raise HTTPException(status_code=404, detail="Symbol not in favorites")
    return {"ok": True}


# ── Shared Order Flow Snapshot Cache ─────────────────────────────────────

_OF_FALLBACK_SYMBOLS = [
    "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT",
    "AVAXUSDT", "LINKUSDT", "SUIUSDT", "NEARUSDT", "ARBUSDT", "OPUSDT",
]
_OF_SNAPSHOT_TTL_SEC = 35.0
_OF_SYMBOLS_TTL_SEC = 300.0
_of_symbols_cache: Dict[str, Any] = {"symbols": list(_OF_FALLBACK_SYMBOLS), "ts": 0.0}
_of_snapshot_cache: Dict[str, Dict[str, Any]] = {}
_of_snapshot_locks: Dict[str, asyncio.Lock] = {}


async def _fetch_liquid_of_symbols(client: httpx.AsyncClient) -> List[str]:
    now = time.time()
    if now - _of_symbols_cache["ts"] < _OF_SYMBOLS_TTL_SEC and _of_symbols_cache["symbols"]:
        return _of_symbols_cache["symbols"]
    try:
        resp = await client.get("https://fapi.binance.com/fapi/v1/ticker/24hr", timeout=6.0)
        if resp.status_code == 200:
            rows = resp.json()
            if isinstance(rows, list):
                liquid = [
                    r["symbol"]
                    for r in sorted(
                        (
                            t for t in rows
                            if isinstance(t.get("symbol"), str)
                            and t["symbol"].endswith("USDT")
                            and "_" not in t["symbol"]
                            and float(t.get("quoteVolume") or 0) >= 5_000_000
                        ),
                        key=lambda t: float(t.get("quoteVolume") or 0),
                        reverse=True,
                    )[:40]
                ]
                if len(liquid) >= 12:
                    _of_symbols_cache["symbols"] = liquid
                    _of_symbols_cache["ts"] = now
                    return liquid
    except Exception:
        pass
    return _of_symbols_cache["symbols"] or list(_OF_FALLBACK_SYMBOLS)


async def _fetch_of_klines(client: httpx.AsyncClient, sem: asyncio.Semaphore, sym: str, tf: str):
    async with sem:
        for url in (
            f"https://fapi.binance.com/fapi/v1/klines?symbol={sym}&interval={tf}&limit=100",
            f"https://api.binance.com/api/v3/klines?symbol={sym}&interval={tf}&limit=100",
        ):
            try:
                resp = await client.get(url, timeout=6.0)
                if resp.status_code == 200:
                    data = resp.json()
                    if isinstance(data, list) and data:
                        return f"{sym}:{tf}", [r[:10] for r in data]
            except Exception:
                continue
        return f"{sym}:{tf}", None


async def _fetch_of_depth(client: httpx.AsyncClient, sem: asyncio.Semaphore, sym: str):
    async with sem:
        try:
            resp = await client.get(
                f"https://fapi.binance.com/fapi/v1/depth?symbol={sym}&limit=25",
                timeout=5.0,
            )
            if resp.status_code == 200:
                data = resp.json()
                if isinstance(data, dict) and data.get("bids") and data.get("asks"):
                    return sym, {"bids": data["bids"], "asks": data["asks"]}
        except Exception:
            pass
        return sym, None


async def build_orderflow_snapshot(timeframe: str = "all") -> Dict[str, Any]:
    tf_key = timeframe if timeframe in ("all", "1m", "3m", "5m", "15m", "1h", "4h", "1d") else "all"
    now = time.time()
    cached = _of_snapshot_cache.get(tf_key)
    if cached and (now - cached["fetched_at"]) < _OF_SNAPSHOT_TTL_SEC:
        return cached["payload"]

    lock = _of_snapshot_locks.setdefault(tf_key, asyncio.Lock())
    async with lock:
        now = time.time()
        cached = _of_snapshot_cache.get(tf_key)
        if cached and (now - cached["fetched_at"]) < _OF_SNAPSHOT_TTL_SEC:
            return cached["payload"]

        target_tfs = ["1m", "5m", "15m"] if tf_key == "all" else [tf_key]
        sem = asyncio.Semaphore(10)
        async with httpx.AsyncClient() as client:
            symbols = await _fetch_liquid_of_symbols(client)
            kline_tasks = [
                _fetch_of_klines(client, sem, sym, tf)
                for tf in target_tfs
                for sym in symbols
            ]
            depth_tasks = [_fetch_of_depth(client, sem, sym) for sym in symbols[:20]]
            funding_task = client.get("https://fapi.binance.com/fapi/v1/premiumIndex", timeout=5.0)

            kline_results, depth_results, funding_res = await asyncio.gather(
                asyncio.gather(*kline_tasks, return_exceptions=True),
                asyncio.gather(*depth_tasks, return_exceptions=True),
                funding_task,
                return_exceptions=True,
            )

        klines: Dict[str, list] = {}
        if isinstance(kline_results, list):
            for item in kline_results:
                if isinstance(item, tuple) and item[1]:
                    klines[item[0]] = item[1]

        depths: Dict[str, dict] = {}
        if isinstance(depth_results, list):
            for item in depth_results:
                if isinstance(item, tuple) and item[1]:
                    depths[item[0]] = item[1]

        funding: Dict[str, float] = {}
        sym_set = set(symbols)
        if not isinstance(funding_res, Exception) and getattr(funding_res, "status_code", 0) == 200:
            try:
                for row in funding_res.json():
                    sym = row.get("symbol")
                    if sym in sym_set:
                        funding[sym] = float(row.get("lastFundingRate") or 0.0)
            except Exception:
                pass

        # If Binance failed completely, keep previous stale cache instead of overwriting with empty
        if not klines and cached:
            return cached["payload"]

        payload = {
            "ts": int(time.time() * 1000),
            "ttl": int(_OF_SNAPSHOT_TTL_SEC),
            "timeframe": tf_key,
            "watchedCount": len(symbols),
            "symbols": symbols,
            "klines": klines,
            "depths": depths,
            "funding": funding,
        }
        _of_snapshot_cache[tf_key] = {"fetched_at": time.time(), "payload": payload}
        return payload


@router.get("/orderflow/snapshot")
async def get_orderflow_snapshot(timeframe: str = Query("all")):
    """Shared cached Order Flow snapshot so all users share one upstream Binance scan."""
    payload = await build_orderflow_snapshot(timeframe)
    return JSONResponse(
        content=payload,
        headers={"Cache-Control": "public, max-age=25, stale-while-revalidate=35"},
    )


# ── Health ───────────────────────────────────────────────────────────────

@router.get("/health")
async def health_check():
    return {
        "status": "online",
        "buffers_count": len(market_store.buffers),
        "timestamp": int(time.time() * 1000)
    }
