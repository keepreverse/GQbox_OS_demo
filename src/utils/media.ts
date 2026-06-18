// ─── Утилиты для работы с медиафайлами ────────────────────────────────────

import type { ProductMedia } from '@app-types';
import { API_BASE } from '@api/client';

/**
 * Человекочитаемое представление размера файла (B / KB / MB / GB).
 * Используется в MediaManager и карточках товара.
 */
export function formatBytes(bytes: number | undefined | null): string {
  if (!bytes || bytes <= 0 || !Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const decimals = v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(decimals)} ${units[i]}`;
}

/**
 * Превращает относительный URL бэка (например, `/uploads/abc.jpg`)
 * или blob-URL (`blob:...`) в абсолютный URL, понятный браузеру.
 * Если URL пустой — возвращает пустую строку.
 *
 * Зачем: на dev-сервере бэк и фронт на одном origin → URL оставляем как есть.
 * На проде (Synology) бэк может быть на отдельном поддомене — достаточно
 * передать `API_BASE` через `VITE_API_BASE_URL` или прямо тут дополнить.
 */
export function getMediaUrl(url: string | undefined | null): string {
  if (!url) return '';
  if (url.startsWith('blob:') || url.startsWith('data:') || /^https?:\/\//i.test(url)) {
    return url;
  }
  if (!API_BASE) return url;
  return `${API_BASE}${url.startsWith('/') ? url : `/${url}`}`;
}

/**
 * Удобный селектор: true, если у медиа есть реальный (или blob) URL,
 * который можно показать в <img>/<video>.
 */
export function hasPlayableUrl(m: Pick<ProductMedia, 'url'> | undefined | null): boolean {
  return !!m && !!m.url && m.url.length > 0;
}
