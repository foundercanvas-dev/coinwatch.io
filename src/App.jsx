import React, { useState, useEffect } from "react";
import Sidebar from "./components/Sidebar";
import useLocalStorage, { RISK_PROFILES } from "./lib/useLocalStorage";
import PumpDumpView from "./components/PumpDumpView";
import MarketsView from "./components/MarketsView";
import POAView from "./components/POAView";
import SettingsView from "./components/SettingsView";
import MarketDetail from "./components/MarketDetail";
import useLiveMarket from "./lib/useLiveMarket";
import POAModal from "./components/POAModal";
import CorrelationView from "./components/CorrelationView";
import OrderFlowView, { fetchOrderFlowNewSignals } from "./components/OrderFlowView";
import CoinIcon from "./components/CoinIcon";
import { fmtPrice, fmtTime } from "./lib/format";
import { rewardRatioFor, SENSITIVITY_POLICY } from "./lib/signalPolicy";

const NAV_TO_PATH = {
  pump_dump: "scanner",
  order_flow: "orderflow",
  correlation: "correlation",
  poa: "poa",
  markets: "markets",
  settings: "settings",
};

function resolveInitialNav() {
  try {
    const h = window.location.hash.replace(/^#\/?/, "");
    const [path] = h.split("?");
    const [seg] = path.split("/");
    if (seg === "market") return "market";
    const fromHash = Object.entries(NAV_TO_PATH).find(([, v]) => v === seg)?.[0];
    if (fromHash) return fromHash;
    const saved = localStorage.getItem("cw.active_nav");
    if (saved && NAV_TO_PATH[saved]) return saved;
  } catch {
    /* ignore */
  }
  return "pump_dump";
}

export default function App() {
  const [activeNav, setActiveNavState] = useState(resolveInitialNav); // 'pump_dump' | 'correlation' | 'poa' | 'markets' | 'settings' | 'market'
  const [sensitivity, setSensitivity] = useState(SENSITIVITY_POLICY.default_pct);
  const [timeframe, setTimeframe] = useState("1m"); // '1m' | '5m' | '15m' | '1h' | '4h'
  const [minLiquidity, setMinLiquidity] = useState(0);
  const rewardRatio = rewardRatioFor(timeframe);
  const [apiLatencyMs, setApiLatencyMs] = useState(null);
  const [reconnectCount, setReconnectCount] = useState(0);
  const [stats, setStats] = useState({
    monitored: 0,
    eligible: 0,
    stream_batches: "0 / 4",
    last_event: "—",
    last_event_ts: 0,
    crossing_now: 0,
    pumps: 0,
    dumps: 0,
  });

  const [liveSignals, setLiveSignals] = useState([]);
  const [historySignals, setHistorySignals] = useState([]);
  const [scannerData, setScannerData] = useState([]);
  const [isConnected, setIsConnected] = useState(false);

  // Filters for Markets view
  const [filters, setFilters] = useState({
    exchange: "all",
    minVolume: 5000000,
    flow: "ALL",
    decoupledOnly: false,
    signal: "ALL",
    search: "",
  });

  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useLocalStorage("cw.sidebar.collapsed", false);
  const [soundEnabled, setSoundEnabled] = useLocalStorage("cw.sound.enabled", true);
  const [theme, setTheme] = useLocalStorage("cw.theme", "dark");
  const [historyClearedAt, setHistoryClearedAt] = useLocalStorage("cw.history.clearedAt", 0);
  const [risk, setRisk] = useLocalStorage("cw.risk", {
    configured: false,
    profile: "easy",
    balance: 10000,
    ...RISK_PROFILES.easy,
  });
  const [activity, setActivity] = useLocalStorage("cw.activity", []);
  const logActivity = (entry) =>
    setActivity((prev) =>
      [{ id: Date.now() + Math.random(), at: Date.now(), ...entry }, ...prev].slice(0, 2000),
    );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  // Disable browser right-click / Inspect globally; custom chart menu handles its own right-click
  useEffect(() => {
    const blockContext = (e) => e.preventDefault();
    const blockKeys = (e) => {
      if (
        e.key === "F12" ||
        ((e.ctrlKey || e.metaKey) && e.shiftKey && ["I", "J", "C"].includes(e.key.toUpperCase())) ||
        ((e.ctrlKey || e.metaKey) && e.key.toUpperCase() === "U")
      ) {
        e.preventDefault();
      }
    };
    document.addEventListener("contextmenu", blockContext);
    document.addEventListener("keydown", blockKeys);
    return () => {
      document.removeEventListener("contextmenu", blockContext);
      document.removeEventListener("keydown", blockKeys);
    };
  }, []);

  // Market detail + modal state
  const [selectedCoin, setSelectedCoinState] = useState(null);
  const [returnNav, setReturnNav] = useState("pump_dump");
  const [poaTargetCoin, setPoaTargetCoin] = useState(null);

  // Hash routing: #/scanner, #/orderflow, #/correlation, #/poa, #/markets, #/settings, #/market/SYMBOL
  const setActiveNav = (nav) => {
    setActiveNavState(nav);
    try {
      if (NAV_TO_PATH[nav]) localStorage.setItem("cw.active_nav", nav);
    } catch {
      /* ignore */
    }
    if (NAV_TO_PATH[nav]) window.location.hash = `/${NAV_TO_PATH[nav]}`;
  };
  const openMarket = (coin) => {
    if (!coin?.symbol) return;
    if (activeNav !== "market") setReturnNav(activeNav);
    setSelectedCoinState(coin);
    setActiveNavState("market");
    window.location.hash = `/market/${coin.symbol}?ex=${(coin.exchange || "binance").toLowerCase()}${coin.coin ? `&coin=${coin.coin}` : ""}`;
  };
  useEffect(() => {
    const apply = () => {
      const h = window.location.hash.replace(/^#\/?/, "");
      const [path, query = ""] = h.split("?");
      const [seg, sym] = path.split("/");
      if (seg === "market" && sym) {
        const q = new URLSearchParams(query);
        setSelectedCoinState((cur) =>
          cur && cur.symbol === sym
            ? cur
            : { symbol: sym, exchange: q.get("ex") || "binance", coin: q.get("coin") || undefined },
        );
        setActiveNavState("market");
        return;
      }
      const nav = Object.entries(NAV_TO_PATH).find(([, v]) => v === seg)?.[0];
      if (nav) {
        setActiveNavState(nav);
        try {
          localStorage.setItem("cw.active_nav", nav);
        } catch {
          /* ignore */
        }
      }
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, []);

  // Keep one audio context alive and gate every signal source through the
  // persisted sound preference.
  const soundEnabledRef = React.useRef(soundEnabled);
  const audioContextRef = React.useRef(null);
  useEffect(() => {
    soundEnabledRef.current = soundEnabled;
  }, [soundEnabled]);

  useEffect(
    () => () => {
      audioContextRef.current?.close().catch(() => {});
    },
    [],
  );

  // Web Audio Ping
  const playAlertSound = () => {
    if (!soundEnabledRef.current) return;

    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      const audioCtx = audioContextRef.current || new AudioContext();
      audioContextRef.current = audioCtx;

      const ping = () => {
        const now = audioCtx.currentTime;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(880, now);
        osc.frequency.exponentialRampToValueAtTime(1320, now + 0.15);
        gain.gain.setValueAtTime(0.15, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(now);
        osc.stop(now + 0.2);
      };

      if (audioCtx.state === "suspended") {
        audioCtx
          .resume()
          .then(ping)
          .catch(() => {});
      } else {
        ping();
      }
    } catch (e) {}
  };

  const toggleSound = () => {
    const next = !soundEnabled;
    soundEnabledRef.current = next;
    setSoundEnabled(next);
    if (next) playAlertSound();
  };

  // Fetch Pump/Dump data for active timeframe & sensitivity
  const fetchPumpDumpData = () => {
    const startedAt = performance.now();
    fetch(
      `/api/pump-dump/stats?sensitivity=${sensitivity}&timeframe=${timeframe}&min_liquidity=${minLiquidity}`,
    )
      .then((r) => r.json())
      .then((d) => {
        if (d && typeof d === "object") setStats(d);
        setApiLatencyMs(Math.round(performance.now() - startedAt));
      })
      .catch(() => {});

    fetch(
      `/api/pump-dump/signals?sensitivity=${sensitivity}&view=live&timeframe=${timeframe}&min_liquidity=${minLiquidity}`,
    )
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d)) setLiveSignals(d);
      })
      .catch(() => {});

    fetch(
      `/api/pump-dump/signals?sensitivity=${sensitivity}&view=history&timeframe=${timeframe}&min_liquidity=${minLiquidity}`,
    )
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d)) setHistorySignals(d);
      })
      .catch(() => {});
  };

  // Fetch Markets snapshot
  const fetchMarketsSnapshot = () => {
    fetch("/api/scanner/snapshot")
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setScannerData(data);
      })
      .catch(() => {});
  };

  useEffect(() => {
    fetchPumpDumpData();
    fetchMarketsSnapshot();

    const interval = setInterval(() => {
      fetchPumpDumpData();
    }, 2000);

    const marketsInterval = setInterval(() => {
      fetchMarketsSnapshot();
    }, 5000);

    return () => {
      clearInterval(interval);
      clearInterval(marketsInterval);
    };
  }, [sensitivity, timeframe, minLiquidity]);

  // WebSocket Live Connection
  useEffect(() => {
    let ws = null;
    let reconnectTimer = null;
    let disposed = false;

    const connectWebSocket = () => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/ws/scanner`;
      ws = new WebSocket(wsUrl);

      ws.onopen = () => setIsConnected(true);

      ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload.type === "NEW_PUMP_DUMP_SIGNAL") {
            const sig = payload.data;
            const matchesTf = !sig.timeframe || sig.timeframe === timeframe;
            if (
              matchesTf &&
              (Math.abs(sig.change_pct) >= sensitivity || sig.amplitude >= sensitivity)
            ) {
              setLiveSignals((prev) => [sig, ...prev.filter((x) => x.id !== sig.id)].slice(0, 10));
              playAlertSound();
            }
          } else if (payload.type === "STATS_UPDATE") {
            if (payload.data && typeof payload.data === "object") {
              if (!payload.data.timeframe || payload.data.timeframe === timeframe) {
                setStats(payload.data);
              }
            }
          } else if (payload.type === "SCANNER_TICK") {
            const updates = payload.data;
            setScannerData((prev) => {
              const map = new Map(prev.map((row) => [`${row.exchange}:${row.symbol}`, row]));
              for (const u of updates) {
                map.set(`${u.exchange}:${u.symbol}`, u);
              }
              return Array.from(map.values());
            });
          }
        } catch (e) {}
      };

      ws.onclose = () => {
        setIsConnected(false);
        if (disposed) return;
        setReconnectCount((count) => count + 1);
        reconnectTimer = setTimeout(connectWebSocket, 3000);
      };

      ws.onerror = () => ws.close();
    };

    connectWebSocket();

    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      if (ws) ws.close();
    };
  }, [sensitivity, timeframe]);

  // Browser-side exchange engine — used whenever the backend has no market data.
  const backendLive = scannerData.length > 0;
  const engine = useLiveMarket({
    enabled: !backendLive,
    sensitivity,
    timeframe,
  });
  const viewStats = backendLive
    ? stats
    : engine.stats || {
        monitored: 0,
        stream_batches: "0 / 4",
        last_event: "—",
        crossing_now: 0,
        pumps: 0,
        dumps: 0,
      };
  const viewLive = backendLive ? liveSignals : engine.live;
  const viewHistory = backendLive ? historySignals : engine.history;
  const viewRows = backendLive ? scannerData : engine.rows;
  const viewConnected = backendLive ? isConnected : engine.connected > 0;
  const sourceLabel = backendLive
    ? "coinwatch backend stream"
    : `Direct exchange streams · ${Object.entries(engine.status || {})
        .map(([k, v]) => `${k}: ${v}`)
        .join(" · ")}`;
  const newestTick = Math.max(0, ...viewRows.map((row) => Number(row.last_update_ts || 0)));
  const displayStats = {
    ...viewStats,
    eligible: viewRows.length
      ? (minLiquidity > 0 ? viewRows.filter((row) => Number(row.volume_24h_usd || 0) >= minLiquidity).length : viewRows.length)
      : (viewStats.eligible || viewStats.monitored || 0),
    last_tick_age_ms: newestTick
      ? Math.max(0, Date.now() - newestTick)
      : viewStats.last_tick_age_ms,
    latency_ms: apiLatencyMs,
    reconnects: reconnectCount,
  };

  useEffect(() => {
    if (activeNav !== "market" || selectedCoin?.id == null) return;
    const latest = [...viewLive, ...viewHistory].find(
      (signal) =>
        String(signal.id) === String(selectedCoin.id) &&
        signal.exchange === selectedCoin.exchange &&
        signal.symbol === selectedCoin.symbol,
    );
    if (
      latest &&
      (latest.lifecycle_status !== selectedCoin.lifecycle_status ||
        latest.outcome !== selectedCoin.outcome ||
        latest.tier !== selectedCoin.tier)
    ) {
      setSelectedCoinState(latest);
    }
  }, [activeNav, selectedCoin, viewLive, viewHistory]);

  // Alert ping for new live signals from the engine
  const seenIds = React.useRef(new Set());
  useEffect(() => {
    if (backendLive) return;
    let fresh = false;
    for (const s of engine.live) {
      if (!seenIds.current.has(s.id)) {
        if (seenIds.current.size) fresh = true;
        seenIds.current.add(s.id);
      }
    }
    if (fresh) playAlertSound();
  }, [engine.live, backendLive]);

  // Global 8-second popup notification whenever a new Order Flow setup arrives (works on any tab)
  const [popupsEnabled, setPopupsEnabled] = useLocalStorage("cw.orderflow.popups", true);
  const [orderFlowToast, setOrderFlowToast] = useState(null);
  const [pendingOrderFlowSignal, setPendingOrderFlowSignal] = useState(null);
  const seenOrderFlowIdsRef = React.useRef(new Set());
  const orderFlowSeededRef = React.useRef(false);
  const orderFlowToastTimerRef = React.useRef(null);

  const notifyOrderFlow = React.useCallback(
    (list) => {
      if (!Array.isArray(list)) return;
      if (!orderFlowSeededRef.current) {
        for (const s of list) seenOrderFlowIdsRef.current.add(s.id);
        orderFlowSeededRef.current = true;
        return;
      }
      if (!list.length) return;
      const freshSig = list.find((s) => !seenOrderFlowIdsRef.current.has(s.id));
      for (const s of list) seenOrderFlowIdsRef.current.add(s.id);
      if (!freshSig || !popupsEnabled) return;

      setOrderFlowToast(freshSig);
      playAlertSound();
      if (orderFlowToastTimerRef.current) clearTimeout(orderFlowToastTimerRef.current);
      orderFlowToastTimerRef.current = setTimeout(() => {
        setOrderFlowToast(null);
      }, 8000);
    },
    [popupsEnabled],
  );

  useEffect(() => {
    if (activeNav === "order_flow") return undefined;
    let alive = true;
    const poll = async () => {
      try {
        const list = await fetchOrderFlowNewSignals();
        if (alive) notifyOrderFlow(list);
      } catch {
        /* ignore */
      }
    };
    poll();
    const timer = setInterval(poll, 10000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [activeNav, notifyOrderFlow]);

  return (
    <div className="flex flex-col lg:flex-row h-screen w-screen overflow-hidden bg-ink text-snow font-sans antialiased">
      <Sidebar
        activeNav={activeNav === "market" ? returnNav : activeNav}
        setActiveNav={setActiveNav}
        mobileOpen={mobileNavOpen}
        setMobileOpen={setMobileNavOpen}
        soundEnabled={soundEnabled}
        onToggleSound={toggleSound}
        theme={theme}
        onToggleTheme={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed((current) => !current)}
      />

      <main className="@container flex-1 min-h-0 min-w-0 h-full overflow-y-auto">
        <div
          key={activeNav}
          className="tab-transition mx-auto max-w-[1240px] px-4 md:px-8 py-6 md:py-8"
        >
          {activeNav === "pump_dump" && (
            <PumpDumpView
              sensitivity={sensitivity}
              setSensitivity={setSensitivity}
              timeframe={timeframe}
              setTimeframe={setTimeframe}
              stats={displayStats}
              liveSignals={viewLive}
              historySignals={viewHistory}
              selectedCoin={selectedCoin}
              onSelectCoin={openMarket}
              isConnected={viewConnected}
              sourceLabel={sourceLabel}
              minLiquidity={minLiquidity}
              setMinLiquidity={setMinLiquidity}
              marketRows={viewRows}
              historyClearedAt={historyClearedAt}
              onClearHistory={() => setHistoryClearedAt(Date.now())}
            />
          )}

          {activeNav === "order_flow" && (
            <OrderFlowView
              risk={risk}
              setActiveNav={setActiveNav}
              initialSignal={pendingOrderFlowSignal}
              onConsumedInitialSignal={() => setPendingOrderFlowSignal(null)}
              onNewSignals={notifyOrderFlow}
              popupsEnabled={popupsEnabled}
              onTogglePopups={() => {
                setPopupsEnabled((v) => !v);
                setOrderFlowToast(null);
              }}
            />
          )}

          {activeNav === "correlation" && (
            <CorrelationView marketRows={viewRows} onSelectCoin={openMarket} />
          )}

          {activeNav === "markets" && (
            <MarketsView
              scannerData={viewRows}
              filters={filters}
              setFilters={setFilters}
              onSelectCoin={openMarket}
              isConnected={viewConnected}
              sourceLabel={sourceLabel}
            />
          )}

          {activeNav === "settings" && (
            <SettingsView
              risk={risk}
              setRisk={setRisk}
              soundEnabled={soundEnabled}
              onToggleSound={toggleSound}
              theme={theme}
              setTheme={setTheme}
            />
          )}

          {activeNav === "market" && selectedCoin && (
            <MarketDetail
              key={`${selectedCoin.exchange}:${selectedCoin.symbol}:${selectedCoin.id ?? selectedCoin.candle_ts ?? "market"}`}
              coin={selectedCoin}
              sensitivity={sensitivity}
              risk={risk}
              onBack={() => setActiveNav(returnNav)}
              setActiveNav={setActiveNav}
            />
          )}
        </div>
      </main>

      {orderFlowToast && popupsEnabled && (
        <div
          key={orderFlowToast.id}
          className={`fixed top-5 right-5 z-50 w-[340px] max-w-[calc(100vw-2rem)] cw-panel cw-glow p-4 shadow-2xl overflow-hidden space-y-3 cw-toast-in ${
            orderFlowToast.side === "LONG"
              ? "!border-mint/50 cw-vol-high-up"
              : "!border-coral/50 cw-vol-high-down"
          }`}
        >
          <div className="pointer-events-none absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-white/[0.06] to-transparent cw-sweep" />
          <div className="relative flex items-start justify-between gap-2.5">
            <div className="flex items-center gap-2.5 min-w-0">
              <CoinIcon
                symbol={orderFlowToast.symbol}
                coin={orderFlowToast.symbol.replace(/USDT$/, "")}
                exchange="binance"
                className="w-8 h-8 shrink-0"
                isPump={orderFlowToast.side === "LONG"}
              />
              <div className="min-w-0">
                <div className="text-[12px] font-semibold text-mint">
                  New Order Flow Setup
                </div>
                <div className="text-[13px] font-semibold text-snow truncate">
                  {orderFlowToast.symbol.replace(/USDT$/, "")}/USDT ·{" "}
                  <span className={orderFlowToast.side === "LONG" ? "text-mint" : "text-coral"}>
                    {orderFlowToast.side}
                  </span>{" "}
                  <span className="text-[11px] text-fog-2 uppercase">
                    ({orderFlowToast.timeframe})
                  </span>
                </div>
                <div className="text-[11px] text-fog-2 cw-num">
                  Level: {fmtPrice(orderFlowToast.price)} ·{" "}
                  {fmtTime((orderFlowToast.time + new Date().getTimezoneOffset() * 60) * 1000)}
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setOrderFlowToast(null)}
              className="text-fog-2 hover:text-snow text-[13px] px-1"
              aria-label="Close notification"
            >
              ✕
            </button>
          </div>
          <div className="relative flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setPendingOrderFlowSignal(orderFlowToast);
                setOrderFlowToast(null);
                setActiveNav("order_flow");
              }}
              className="cw-btn cw-btn-primary !h-8 !px-3 !text-[11px] flex-1"
            >
              Open Order Flow
            </button>
          </div>
          <div className="relative h-1 w-full rounded-full bg-white/[0.06] overflow-hidden">
            <div
              className={`h-full cw-toast-bar ${
                orderFlowToast.side === "LONG" ? "bg-mint" : "bg-coral"
              }`}
            />
          </div>
        </div>
      )}
    </div>
  );
}
