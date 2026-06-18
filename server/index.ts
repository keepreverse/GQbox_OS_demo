import express from 'express';
import cors from 'cors';
import { resolve } from 'path';

// Demo mode (JSON-only, без fallback на БД)
import demoProducts from './routes/demo/products';
import demoDictionaries from './routes/demo/dictionaries';
import demoSettings from './routes/demo/settings';
import demoNotifications from './routes/demo/notifications';
import demoKitComponents from './routes/demo/kitComponents';
import demoMedia from './routes/demo/media';

// Dev mode (PostgreSQL-only)
import devProducts from './routes/dev/products';
import devDictionaries from './routes/dev/dictionaries';
import devSettings from './routes/dev/settings';
import devNotifications from './routes/dev/notifications';
import devKitComponents from './routes/dev/kitComponents';
import devMedia from './routes/dev/media';
import devInspector from './routes/dev/inspect';

import auth from './routes/auth';
import devUsers from './routes/dev/users';
import analytics from './routes/analytics';

import { errorHandler } from './middleware/errorHandler';
import { requireAuth, requireAdmin } from './middleware/auth';
import { closePool } from './utils/db';
import { startHourlyRefresh } from './services/wbAnalytics';
import { startHourlyRefresh as startSearchReportRefresh } from './services/wbSearchReport';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;
const app = express();

const DEFAULT_ORIGINS = ['http://localhost:5173', 'http://localhost:3000', 'https://keepreverse.github.io'];
const CORS_ORIGIN = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim())
  : DEFAULT_ORIGINS;

app.use(cors({
  origin: CORS_ORIGIN,
  credentials: false,
  allowedHeaders: ['Content-Type', 'Authorization', 'X-GQbox-Mode'],
}));

// Multer (multipart/form-data) для /api/*/media не использует JSON-парсер,
// поэтому монтируем multer-роуты ДО express.json(). Но express.json() с
// `verify: false` безопасно игнорирует multipart. Чтобы не ломать
// остальные роуты, держим JSON-парсер после static (см. ниже).
//
// Сначала — статика загруженных медиафайлов.
const UPLOADS_DIR = resolve(process.cwd(), 'server', 'uploads');
app.use('/uploads', express.static(UPLOADS_DIR, {
  maxAge: '7d',
  fallthrough: false,
}));

// JSON-парсер для всех остальных роутов (кроме multipart /api/*/media).
app.use((req, res, next) => {
  const ct = (req.headers['content-type'] || '').toString();
  if (ct.startsWith('multipart/form-data')) {
    next();
    return;
  }
  express.json({ limit: '10mb' })(req, res, next);
});

// ─── Public health ────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    modes: ['demo', 'dev'],
  });
});

// ─── Auth (mode-aware: demo JSON / dev PostgreSQL) ────────────────────────
app.use('/api/auth', auth);

// ─── Analytics (WB Seller API proxy with cache) ───────────────────────────
app.use('/api/analytics', analytics);

// ─── Demo (JSON-files) ───────────────────────────────────────────────────
app.use('/api/demo/products', demoProducts);
app.use('/api/demo/dictionaries', demoDictionaries);
app.use('/api/demo', demoSettings);
app.use('/api/demo/notifications', demoNotifications);
app.use('/api/demo/kit-components', demoKitComponents);
app.use('/api/demo/media', demoMedia);

// ─── Dev (PostgreSQL) ────────────────────────────────────────────────────
// Everything under /api/dev requires admin authentication.
app.use('/api/dev', requireAuth, requireAdmin);
app.use('/api/dev/products', devProducts);
app.use('/api/dev/dictionaries', devDictionaries);
app.use('/api/dev', devSettings);
app.use('/api/dev/notifications', devNotifications);
app.use('/api/dev/kit-components', devKitComponents);
app.use('/api/dev/media', devMedia);
app.use('/api/dev/inspector', devInspector);
app.use('/api/dev/users', devUsers);

app.use(errorHandler);

// ─── Bootstrap ───────────────────────────────────────────────────────────
// Демо-режим не требует init. Дев-режим — требует, но это ответственность
// пользователя: сначала `npm run db:start`, потом `npm run db:seed`,
// потом уже включать переключатель. Поэтому initSchema НЕ вызываем здесь,
// чтобы не падать, если БД не поднята. Каждый dev-роут сам проверяет
// доступность через isDbAvailable() и возвращает 503, если что.
app.listen(PORT, () => {
  console.log(`GQbox API running on http://localhost:${PORT}`);
  console.log(`  demo: /api/demo/*  (JSON files)`);
  console.log(`  dev:  /api/dev/*   (PostgreSQL, requires db:start)`);
  console.log(`  analytics: /api/analytics/wb/*  (WB Seller API proxy)`);
  console.log(`  static: /uploads/*  (uploaded media files)`);
  // Фоновый warmup кеша WB-аналитики + обновление каждый час.
  // Неблокирующий — сервер стартует сразу, warmup идёт в фоне через 5 сек.
  startHourlyRefresh();
  // Search Report: warmup стартует позже (через 8 сек) и идёт отдельной
  // serial-очередью с интервалом ~1 мин, чтобы не словить 429 от WB.
  startSearchReportRefresh();
});

process.on('SIGINT', async () => {
  await closePool();
  process.exit(0);
});
