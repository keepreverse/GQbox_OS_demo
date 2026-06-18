import { Router, type Request, type Response } from 'express';
import { fetchWbSalesFunnel, WbAnalyticsError } from '../services/wbAnalytics';

const router = Router();

// POST /api/analytics/wb/sales-funnel
// Body: { nmIds: number[], startDate: string, endDate: string }
// startDate / endDate в формате YYYY-MM-DD
router.post('/wb/sales-funnel', async (req: Request, res: Response) => {
  try {
    const { nmIds, startDate, endDate } = req.body ?? {};

    // ─── Валидация ──────────────────────────────────────────────────────
    if (!Array.isArray(nmIds) || nmIds.length === 0) {
      res.status(400).json({ error: 'nmIds должен быть непустым массивом' });
      return;
    }
    if (nmIds.length > 1000) {
      res.status(400).json({ error: 'nmIds не может содержать больше 1000 элементов' });
      return;
    }
    if (!startDate || !endDate || typeof startDate !== 'string' || typeof endDate !== 'string') {
      res.status(400).json({ error: 'startDate и endDate обязательны (YYYY-MM-DD)' });
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      res.status(400).json({ error: 'Даты должны быть в формате YYYY-MM-DD' });
      return;
    }
    if (new Date(startDate) > new Date(endDate)) {
      res.status(400).json({ error: 'startDate не может быть позже endDate' });
      return;
    }

    const result = await fetchWbSalesFunnel(nmIds, startDate, endDate);
    res.json(result);
  } catch (err) {
    if (err instanceof WbAnalyticsError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

export default router;
