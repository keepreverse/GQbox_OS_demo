// ─── Ozon Analytics frontend client ────────────────────────────────────────
// Тонкий клиент поверх /api/analytics/ozon/sales-funnel. Использует общий
// request() из client.ts.

import { request } from './client';

export interface OzonArticleMetrics {
  sku: number;
  selected: {
    openCount: number;
    orderCount: number;
    orderSum: number;
    buyoutCount: number;
    hitsViewSearch: number;
    paidClicks: number;
    paidViews: number;
  };
  past: {
    openCount: number;
    orderCount: number;
    orderSum: number;
    buyoutCount: number;
    hitsViewSearch: number;
    paidClicks: number;
    paidViews: number;
  };
  dynamics: {
    openCount: number;
    orderCount: number;
    orderSum: number;
    buyoutCount: number;
    hitsViewSearch: number;
    paidClicks: number;
    paidViews: number;
  };
}

export interface OzonAnalyticsResponse {
  currency: string;
  articles: OzonArticleMetrics[];
  cached: boolean;
  updating?: boolean;
}

export async function fetchOzonAnalytics(
  skus: number[],
  startDate: string,
  endDate: string
): Promise<OzonAnalyticsResponse> {
  return request<OzonAnalyticsResponse>('/api/analytics/ozon/sales-funnel', {
    method: 'POST',
    body: JSON.stringify({ skus, startDate, endDate }),
  });
}
