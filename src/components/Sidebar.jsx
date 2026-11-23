import React from "react";
import {
  ChartLineUp,
  ClipboardText,
  ChartBar,
  GearSix,
  SignOut,
  List,
  X,
  SpeakerHigh,
  SpeakerSlash,
  ShareNetwork,
  Moon,
  Sun,
  UserCircle,
  CaretLeft,
  CaretRight,
} from "@phosphor-icons/react";
import { BrandMark, BRAND } from "./ui";

export const NAV_ITEMS = [
  { id: "pump_dump", label: "Pump / Dump", icon: ChartLineUp },
  { id: "correlation", label: "Correlation", icon: ShareNetwork },
  { id: "poa", label: "POA", icon: ClipboardText },
  { id: "markets", label: "Markets", icon: ChartBar },
  { id: "settings", label: "Settings", icon: GearSix },
];

function Brand({ collapsed = false }) {
  return (
    <div className={`flex items-center ${collapsed ? "justify-center" : "gap-2.5"}`}>
      <span className="w-9 h-9 rounded-xl bg-ink-3 border border-white/[0.07] flex items-center justify-center">
        <BrandMark className="w-6 h-6" />
      </span>
      {!collapsed && (
        <span className="leading-tight">
          <span className="block text-[17px] font-semibold tracking-tight cw-title">{BRAND}</span>
          <span className="block text-[10px] text-fog-2">Market intelligence</span>
        </span>
      )}
    </div>
  );
}

function NavList({ activeNav, onNavigate, collapsed = false }) {
  return (
    <nav className="space-y-1" aria-label="Dashboard">
      {NAV_ITEMS.map(({ id, label, icon: Icon }) => {
        const active = activeNav === id;
        return (
          <button
            key={id}
            onClick={() => onNavigate(id)}
            aria-current={active ? "page" : undefined}
            aria-label={label}
            title={collapsed ? label : undefined}
            className={`group relative w-full flex items-center h-10 rounded-xl text-[14px] transition-colors duration-150 ${
              collapsed ? "justify-center px-0" : "gap-3 px-3"
            } ${
              active
                ? "bg-white/[0.05] text-snow"
                : "text-fog hover:text-snow hover:bg-white/[0.025]"
            }`}
          >
            <span
              className={`absolute left-0 top-1/2 -translate-y-1/2 w-[3px] rounded-full bg-mint transition-all duration-150 ${
                active ? "h-5 opacity-100" : "h-0 opacity-0"
              }`}
            />
            <Icon
              weight={active ? "fill" : "duotone"}
              className={`w-[18px] h-[18px] ${active ? "text-mint" : ""}`}
            />
            {!collapsed && label}
          </button>
        );
      })}
    </nav>
  );
}

function PreferenceToggle({
  enabled,
  onToggle,
  label,
  enabledIcon: EnabledIcon,
  disabledIcon: DisabledIcon,
  enabledLabel,
  disabledLabel,
  collapsed = false,
}) {
  const Icon = enabled ? EnabledIcon : DisabledIcon;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={enabled}
      aria-label={enabled ? enabledLabel : disabledLabel}
      title={enabled ? enabledLabel : disabledLabel}
      className={`group w-full h-10 rounded-xl border flex items-center transition-all ${
        collapsed ? "justify-center px-0" : "justify-between px-3"
      } ${
        enabled
          ? "border-mint/20 bg-mint/[0.06] text-snow hover:bg-mint/[0.09]"
          : "border-white/[0.06] bg-white/[0.025] text-fog hover:text-snow hover:border-white/10"
      }`}
    >
      <span className={`flex items-center text-[13px] font-medium ${collapsed ? "" : "gap-3"}`}>
        <Icon
          weight="fill"
          className={`w-[18px] h-[18px] ${enabled ? "text-mint" : "text-fog-2"}`}
        />
        {!collapsed && label}
      </span>
      {!collapsed && (
        <span
          className={`relative w-8 h-[18px] rounded-full transition-colors ${
            enabled ? "bg-mint" : "bg-white/10"
          }`}
          aria-hidden="true"
        >
          <span
            className={`absolute top-[3px] w-3 h-3 rounded-full shadow-sm transition-all ${
              enabled ? "left-[17px] bg-ink" : "left-[3px] bg-fog"
            }`}
          />
        </span>
      )}
    </button>
  );
}

function SessionBox({ soundEnabled, onToggleSound, theme, onToggleTheme, collapsed = false }) {
  return (
    <div className="space-y-3">
      <PreferenceToggle
        enabled={soundEnabled}
        onToggle={onToggleSound}
        label="Sound"
        enabledIcon={SpeakerHigh}
        disabledIcon={SpeakerSlash}
        enabledLabel="Mute signal alerts"
        disabledLabel="Enable signal alerts"
        collapsed={collapsed}
      />
      <PreferenceToggle
        enabled={theme === "light"}
        onToggle={onToggleTheme}
        label={theme === "light" ? "Light mode" : "Dark mode"}
        enabledIcon={Sun}
        disabledIcon={Moon}
        enabledLabel="Switch to dark mode"
        disabledLabel="Switch to light mode"
        collapsed={collapsed}
      />
      <div className={`cw-panel cw-glow cw-glow-soft ${collapsed ? "p-2" : "p-3.5"}`}>
        <div className="flex items-center gap-2.5">
          <span className="cw-disc w-9 h-9">
            <UserCircle weight="fill" className="w-5 h-5 text-mint" />
          </span>
          {!collapsed && (
            <div className="min-w-0">
              <div className="text-[14px] font-medium text-snow truncate">Trader</div>
              <div className="text-[10px] text-fog-2">Starter account</div>
            </div>
          )}
        </div>
        {!collapsed && (
          <button
            onClick={() => window.location.reload()}
            className="cw-btn mt-3 w-full !h-9 !text-[12px]"
          >
            <SignOut weight="duotone" className="w-4 h-4" />
            Sign out
          </button>
        )}
      </div>
    </div>
  );
}

export default function Sidebar({
  activeNav,
  setActiveNav,
  mobileOpen,
  setMobileOpen,
  soundEnabled,
  onToggleSound,
  theme,
  onToggleTheme,
  collapsed,
  onToggleCollapsed,
}) {
  const navigate = (id) => {
    setActiveNav(id);
    setMobileOpen(false);
  };
  return (
    <>
      <aside
        className={`relative hidden lg:flex shrink-0 h-full flex-col justify-between border-r border-white/[0.05] bg-ink transition-[width,padding] duration-200 ${
          collapsed ? "w-[76px] p-3" : "w-[236px] p-4"
        }`}
      >
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="absolute -right-3 top-7 z-10 w-6 h-6 rounded-full border border-white/10 bg-ink-2 text-fog hover:text-mint hover:border-mint/30 flex items-center justify-center transition-colors"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? (
            <CaretRight weight="bold" className="w-3 h-3" />
          ) : (
            <CaretLeft weight="bold" className="w-3 h-3" />
          )}
        </button>
        <div className="space-y-7">
          <div className="px-1 pt-1">
            <Brand collapsed={collapsed} />
          </div>
          <NavList activeNav={activeNav} onNavigate={navigate} collapsed={collapsed} />
        </div>
        <SessionBox
          soundEnabled={soundEnabled}
          onToggleSound={onToggleSound}
          theme={theme}
          onToggleTheme={onToggleTheme}
          collapsed={collapsed}
        />
      </aside>

      <div className="lg:hidden flex items-center justify-between h-14 px-4 border-b border-white/[0.05] bg-ink shrink-0">
        <Brand />
        <button
          onClick={() => setMobileOpen(true)}
          className="w-9 h-9 rounded-xl border border-white/10 flex items-center justify-center text-snow"
          aria-label="Open navigation"
        >
          <List weight="bold" className="w-4 h-4" />
        </button>
      </div>

      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-50">
          <button
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setMobileOpen(false)}
            aria-label="Close navigation"
          />
          <aside className="absolute left-0 top-0 bottom-0 w-[264px] bg-ink border-r border-white/[0.06] p-4 flex flex-col justify-between tab-transition">
            <div className="space-y-7">
              <div className="flex items-center justify-between">
                <Brand />
                <button
                  onClick={() => setMobileOpen(false)}
                  className="w-8 h-8 rounded-lg flex items-center justify-center text-fog"
                  aria-label="Close navigation"
                >
                  <X weight="bold" className="w-4 h-4" />
                </button>
              </div>
              <NavList activeNav={activeNav} onNavigate={navigate} />
            </div>
            <SessionBox
              soundEnabled={soundEnabled}
              onToggleSound={onToggleSound}
              theme={theme}
              onToggleTheme={onToggleTheme}
            />
          </aside>
        </div>
      )}
    </>
  );
}
