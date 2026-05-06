import type { Source } from './player.js';

const STORAGE_KEY = 'source-tabs';

export type TabKey =
  | 'home.recommend'
  | 'home.daily'
  | 'home.user'
  | 'library.user';

function readAll(): Partial<Record<TabKey, Source>> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export function loadTabSource(key: TabKey, fallback: Source = 'netease'): Source {
  const all = readAll();
  const v = all[key];
  return v === 'netease' || v === 'qq' ? v : fallback;
}

export function saveTabSource(key: TabKey, value: Source): void {
  try {
    const all = readAll();
    all[key] = value;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // localStorage may be unavailable (private browsing); silently no-op
  }
}
