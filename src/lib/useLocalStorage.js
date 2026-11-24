import { useEffect, useState } from 'react';

/** useState backed by localStorage (JSON). Falls back silently when storage is unavailable. */
export default function useLocalStorage(key, initialValue) {
  const [value, setValue] = useState(() => {
    try {
      const raw = window.localStorage.getItem(key);
      return raw !== null ? JSON.parse(raw) : initialValue;
    } catch {
      return initialValue;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage full or disabled */
    }
  }, [key, value]);

  return [value, setValue];
}

export const RISK_PROFILES = {
  easy: { label: 'Easy', riskPerTrade: 0.5, maxLoss: 6, rewardRatio: 1.5, entryMode: 'retest' },
  balanced: { label: 'Balanced', riskPerTrade: 1, maxLoss: 10, rewardRatio: 2, entryMode: 'retest' },
  aggressive: { label: 'Aggressive', riskPerTrade: 2, maxLoss: 20, rewardRatio: 2.5, entryMode: 'shallow' },
};
