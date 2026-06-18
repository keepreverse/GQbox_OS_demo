// ─── WB Analytics frontend client ─────────────────────────────────────────
// Тонкий клиент поверх /api/analytics/wb/sales-funnel. Использует общий
// request() из client.ts, поэтому автоматически подставляет API_BASE и токен.

import { request } from './client';

export interface WbArticleMetrics {
  nmId: number;
  vendorCode: string;
  selected: {
    openCount: number;
    orderCount: number;
    orderSum: number;
    buyoutCount: number;
  };
  past: {
    openCount: number;
    orderCount: number;
    orderSum: number;
    buyoutCount: number;
  };
  dynamics: {
    openCount: number; // уже в %, как отдаёт WB
    orderCount: number;
    orderSum: number;
    buyoutCount: number;
  };
}

export interface WbSalesFunnelResponse {
  currency: string;
  articles: WbArticleMetrics[];
  cached: boolean;
}

export async function fetchWbSalesFunnel(
  nmIds: number[],
  startDate: string,
  endDate: string
): Promise<WbSalesFunnelResponse> {
  return request<WbSalesFunnelResponse>('/api/analytics/wb/sales-funnel', {
    method: 'POST',
    body: JSON.stringify({ nmIds, startDate, endDate }),
  });
}
