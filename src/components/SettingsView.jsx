import React, { useState } from "react";
import {
  Bell,
  CheckCircle,
  CreditCard,
  GearSix,
  MoonStars,
  PaperPlaneTilt,
  ShieldCheck,
  SlidersHorizontal,
  SpeakerHigh,
  UserCircle,
} from "@phosphor-icons/react";
import { PageHeader, Segmented } from "./ui";
import useLocalStorage, { RISK_PROFILES } from "../lib/useLocalStorage";

const DEFAULT_PREFERENCES = {
  account: {
    displayName: "Trader",
    email: "",
  },
  notifications: {
    confirmed: true,
    invalidated: true,
    correlation: true,
    browser: false,
    billing: true,
  },
  telegram: {
    chatId: "",
    configured: false,
  },
  cooldown: 15,
};

function Section({ icon: Icon, title, description, children }) {
  return (
    <section className="cw-panel cw-glow cw-glow-soft p-5 md:p-6">
      <div className="flex items-start gap-3">
        <span className="cw-disc w-10 h-10 shrink-0">
          <Icon weight="duotone" className="w-5 h-5" />
        </span>
        <div>
          <h2 className="text-[17px] font-semibold cw-title">{title}</h2>
          <p className="text-[12px] text-fog-2 mt-0.5">{description}</p>
        </div>
      </div>
      <div className="mt-5">{children}</div>
    </section>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="block text-[12px] text-fog mb-1.5">{label}</span>
      {children}
      {hint && <span className="block mt-1 text-[11px] text-fog-2">{hint}</span>}
    </label>
  );
}

function ToggleRow({ label, description, enabled, onChange }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div>
        <div className="text-[13px] text-snow">{label}</div>
        {description && <div className="mt-0.5 text-[11px] text-fog-2">{description}</div>}
      </div>
      <button
        type="button"
        onClick={() => onChange(!enabled)}
        aria-pressed={enabled}
        className={`relative w-9 h-5 shrink-0 rounded-full transition-colors ${
          enabled ? "bg-mint" : "bg-white/10"
        }`}
      >
        <span
          className={`absolute top-1 w-3 h-3 rounded-full transition-all ${
            enabled ? "left-5 bg-ink" : "left-1 bg-fog"
          }`}
        />
      </button>
    </div>
  );
}

export default function SettingsView({
  risk,
  setRisk,
  soundEnabled,
  onToggleSound,
  theme,
  setTheme,
}) {
  const [preferences, setPreferences] = useLocalStorage("cw.preferences", DEFAULT_PREFERENCES);
  const [riskDraft, setRiskDraft] = useState(() => ({ ...risk }));
  const [draft, setDraft] = useState(() => ({
    ...DEFAULT_PREFERENCES,
    ...preferences,
    account: {
      ...DEFAULT_PREFERENCES.account,
      ...preferences.account,
    },
    notifications: {
      ...DEFAULT_PREFERENCES.notifications,
      ...preferences.notifications,
    },
    telegram: {
      ...DEFAULT_PREFERENCES.telegram,
      ...preferences.telegram,
    },
  }));
  const [telegramToken, setTelegramToken] = useState("");
  const [saved, setSaved] = useState(false);

  const pickProfile = (key) =>
    setRiskDraft((current) => ({
      ...current,
      profile: key,
      ...RISK_PROFILES[key],
    }));

  const setNotification = (key, value) =>
    setDraft((current) => ({
      ...current,
      notifications: {
        ...current.notifications,
        [key]: value,
      },
    }));

  const handleSave = () => {
    setRisk({
      ...riskDraft,
      configured: true,
      label: RISK_PROFILES[riskDraft.profile]?.label || riskDraft.label,
    });
    const nextPreferences = {
      ...draft,
      telegram: {
        ...draft.telegram,
        configured: Boolean(telegramToken.trim()) && Boolean(draft.telegram.chatId.trim()),
      },
    };
    setPreferences(nextPreferences);
    setDraft(nextPreferences);
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  const maxLossUsd = ((Number(riskDraft.balance) || 0) * (Number(riskDraft.maxLoss) || 0)) / 100;

  return (
    <div className="space-y-5 max-w-5xl">
      <PageHeader
        eyebrow="Account preferences"
        eyebrowIcon={GearSix}
        title="Settings"
        description="Manage your account, billing, risk, alerts, Telegram channel and interface preferences."
      />

      <div className="grid gap-5 @4xl:grid-cols-2">
        <Section
          icon={UserCircle}
          title="Account"
          description="Profile information shown across your coinwach workspace."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Display name">
              <input
                type="text"
                value={draft.account.displayName}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    account: {
                      ...current.account,
                      displayName: event.target.value,
                    },
                  }))
                }
                className="cw-input"
              />
            </Field>
            <Field label="Email address">
              <input
                type="email"
                placeholder="trader@example.com"
                value={draft.account.email}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    account: {
                      ...current.account,
                      email: event.target.value,
                    },
                  }))
                }
                className="cw-input"
              />
            </Field>
          </div>
        </Section>

        <Section
          icon={CreditCard}
          title="Billing"
          description="Subscription and invoice status for this workspace."
        >
          <div className="grid grid-cols-3 gap-3">
            {[
              ["Current plan", "Starter"],
              ["Billing cycle", "Monthly"],
              ["Renewal", "Not active"],
            ].map(([label, value]) => (
              <div
                key={label}
                className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3"
              >
                <div className="text-[10px] text-fog-2">{label}</div>
                <div className="mt-1 text-[13px] text-snow">{value}</div>
              </div>
            ))}
          </div>
          <ToggleRow
            label="Billing emails"
            description="Receive invoices and subscription updates."
            enabled={draft.notifications.billing}
            onChange={(value) => setNotification("billing", value)}
          />
        </Section>
      </div>

      <Section
        icon={ShieldCheck}
        title="Risk setup"
        description="Applied to every new Plan of Attack, stop distance and position size."
      >
        <div className="space-y-5">
          <Field label="Risk profile">
            <Segmented
              value={riskDraft.profile}
              onChange={pickProfile}
              options={Object.entries(RISK_PROFILES).map(([key, value]) => ({
                value: key,
                label: value.label,
              }))}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Account balance (USD)">
              <input
                type="number"
                min="0"
                value={riskDraft.balance}
                onChange={(event) =>
                  setRiskDraft((current) => ({
                    ...current,
                    balance: Number(event.target.value),
                  }))
                }
                className="cw-input cw-num"
              />
            </Field>
            <Field label="Risk per trade (%)">
              <input
                type="number"
                min="0.1"
                step="0.1"
                value={riskDraft.riskPerTrade}
                onChange={(event) =>
                  setRiskDraft((current) => ({
                    ...current,
                    riskPerTrade: Number(event.target.value),
                  }))
                }
                className="cw-input cw-num"
              />
            </Field>
            <Field
              label="Maximum loss (%)"
              hint={`≈ $${maxLossUsd.toLocaleString()} at this balance`}
            >
              <input
                type="number"
                min="0.5"
                step="0.5"
                value={riskDraft.maxLoss}
                onChange={(event) =>
                  setRiskDraft((current) => ({
                    ...current,
                    maxLoss: Number(event.target.value),
                  }))
                }
                className="cw-input cw-num"
              />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Entry placement"
              hint="Places limit entry at a pullback/retest zone instead of chasing the trigger candle."
            >
              <Segmented
                value={riskDraft.entryMode || "retest"}
                onChange={(value) =>
                  setRiskDraft((current) => ({
                    ...current,
                    entryMode: value,
                  }))
                }
                options={[
                  { value: "shallow", label: "Tight 12%" },
                  { value: "retest", label: "Retest 22%" },
                  { value: "deep", label: "Deep 32%" },
                ]}
              />
            </Field>
            <Field
              label="Take profit (R:R)"
              hint="TP target calculated automatically from your Entry and Stop Loss distance."
            >
              <Segmented
                value={String(riskDraft.rewardRatio ?? 1.5)}
                onChange={(value) =>
                  setRiskDraft((current) => ({
                    ...current,
                    rewardRatio: Number(value),
                  }))
                }
                options={[
                  { value: "1", label: "1:1" },
                  { value: "1.5", label: "1:1.5" },
                  { value: "2", label: "1:2" },
                  { value: "3", label: "1:3" },
                ]}
              />
            </Field>
          </div>
        </div>
      </Section>

      <div className="grid gap-5 @4xl:grid-cols-2">
        <Section
          icon={Bell}
          title="Notifications"
          description="Choose which events can interrupt you."
        >
          <div className="divide-y divide-white/[0.05]">
            <ToggleRow
              label="Confirmed signals"
              description="Pump, dump and bias confirmations."
              enabled={draft.notifications.confirmed}
              onChange={(value) => setNotification("confirmed", value)}
            />
            <ToggleRow
              label="Invalidated signals"
              description="Reversed, stopped or invalidated setups."
              enabled={draft.notifications.invalidated}
              onChange={(value) => setNotification("invalidated", value)}
            />
            <ToggleRow
              label="Correlation changes"
              description="Major relationship and decoupling updates."
              enabled={draft.notifications.correlation}
              onChange={(value) => setNotification("correlation", value)}
            />
            <ToggleRow
              label="Browser notifications"
              description="Desktop alerts while coinwach is in the background."
              enabled={draft.notifications.browser}
              onChange={(value) => setNotification("browser", value)}
            />
          </div>
        </Section>

        <Section
          icon={PaperPlaneTilt}
          title="Telegram"
          description="Configure the private chat used for signal alerts."
        >
          <div className="space-y-4">
            <Field label="Bot token" hint="Kept only for this settings session.">
              <input
                type="password"
                placeholder="Bot API token"
                value={telegramToken}
                onChange={(event) => setTelegramToken(event.target.value)}
                className="cw-input cw-num placeholder:text-fog-2"
              />
            </Field>
            <Field label="Chat ID">
              <input
                type="text"
                placeholder="123456789 or @channel"
                value={draft.telegram.chatId}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    telegram: {
                      ...current.telegram,
                      chatId: event.target.value,
                    },
                  }))
                }
                className="cw-input cw-num placeholder:text-fog-2"
              />
            </Field>
            <div className="text-[11px] text-fog-2">
              Status: {draft.telegram.configured ? "Configured" : "Not connected"}
            </div>
          </div>
        </Section>
      </div>

      <div className="grid gap-5 @4xl:grid-cols-2">
        <Section
          icon={SlidersHorizontal}
          title="Alert cooldown"
          description="Prevents repeated alerts while an asset is trending."
        >
          <div className="flex items-baseline gap-2">
            <span className="cw-num text-[30px] leading-none text-snow">{draft.cooldown}</span>
            <span className="text-[12px] text-fog">minutes</span>
          </div>
          <input
            type="range"
            min="5"
            max="60"
            step="5"
            value={draft.cooldown}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                cooldown: Number(event.target.value),
              }))
            }
            className="mt-4 w-full h-1 cursor-pointer"
            aria-label="Cooldown period in minutes"
          />
        </Section>

        <Section
          icon={MoonStars}
          title="Sound & appearance"
          description="Control alert audio and the application color mode."
        >
          <ToggleRow
            label="Signal sounds"
            description="Play a tone when a new signal is confirmed."
            enabled={soundEnabled}
            onChange={onToggleSound}
          />
          <div className="mt-3">
            <Field label="Color mode">
              <Segmented
                value={theme}
                onChange={setTheme}
                options={[
                  { value: "dark", label: "Dark" },
                  { value: "light", label: "Light" },
                ]}
              />
            </Field>
          </div>
          <div className="mt-3 inline-flex items-center gap-2 text-[11px] text-fog-2">
            <SpeakerHigh weight="fill" className="w-4 h-4" />
            Sidebar controls stay synchronized with these settings.
          </div>
        </Section>
      </div>

      <div className="flex items-center justify-end gap-4">
        {saved && (
          <span className="inline-flex items-center gap-1.5 text-[12px] text-mint" role="status">
            <CheckCircle weight="fill" className="w-4 h-4" /> Settings saved
          </span>
        )}
        <button onClick={handleSave} className="cw-btn-primary !h-10 !px-6">
          Save changes
        </button>
      </div>
    </div>
  );
}
