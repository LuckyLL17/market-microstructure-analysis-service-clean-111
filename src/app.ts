import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { MarketEngine } from './engine.js';
import { OrderBook } from './order-book.js';
import { MarketEvent } from './types.js';

type ReplaySession = {
  id: string;
  symbol: string;
  tradingDay: string;
  cursor: number;
  status: string;
  speed: number;
  eventCount: number;
  lastEvent?: MarketEvent;
  book: OrderBook;
  /** Immutable snapshot of the event sequence captured at creation time. */
  events: readonly MarketEvent[];
};

export function buildApp(engine: MarketEngine = new MarketEngine(), logger: boolean = true): FastifyInstance {
  const app = Fastify({ logger });
  const replaySessions = new Map<string, ReplaySession>();

  app.register(cors, { origin: true });

  app.get('/api/health', async () => ({ status: 'ok', service: 'market-microstructure-analysis-service', version: '0.1.0' }));
  app.get('/api/instruments', async () => [{ symbol: 'ALPHA', tradingDay: '2026-09-30', tickSize: .01, lotSize: 1, currency: 'USD', status: 'replay_ready' }]);
  app.post('/api/market-data/events', async request => engine.ingest(request.body as MarketEvent));
  app.get('/api/orderbook/:symbol', async request => { const { symbol } = request.params as { symbol: string }; return { symbol, ...engine.book(symbol).snapshot(20), stats: engine.book(symbol).getStats() }; });
  app.get('/api/analytics/:symbol', async request => engine.analytics((request.params as { symbol: string }).symbol));

  app.post('/api/replay/sessions', async request => {
    const body = (request.body ?? {}) as { symbol?: string; tradingDay?: string; speed?: number };
    const symbol = body.symbol ?? 'ALPHA';
    const tradingDay = body.tradingDay ?? '2026-09-30';
    // Freeze the event sequence at creation time: late-arriving market data
    // appended to engine.events afterwards must not move this session's boundary.
    const events = Object.freeze(engine.events
      .filter(event => event.symbol === symbol && event.tradingDay === tradingDay)
      .map(event => ({ ...event }))) as readonly MarketEvent[];
    const session: ReplaySession = { id: `REP-${replaySessions.size + 1}`, symbol, tradingDay, cursor: 0, status: 'ready', speed: body.speed ?? 1, eventCount: events.length, book: new OrderBook(symbol), events };
    replaySessions.set(session.id, session);
    return { id: session.id, symbol: session.symbol, tradingDay: session.tradingDay, cursor: session.cursor, status: session.status, speed: session.speed, eventCount: session.eventCount, nextEvent: events[0] ?? null, book: session.book.snapshot(20) };
  });

  app.get('/api/replay/sessions/:id', async request => {
    const session = replaySessions.get((request.params as { id: string }).id);
    if (!session) return { error: 'session_not_found' };
    return { id: session.id, symbol: session.symbol, tradingDay: session.tradingDay, cursor: session.cursor, status: session.status, speed: session.speed, eventCount: session.eventCount, progress: session.eventCount ? +(session.cursor / session.eventCount * 100).toFixed(2) : 100, currentEvent: session.events[session.cursor - 1] ?? null, nextEvent: session.events[session.cursor] ?? null, book: session.book.snapshot(20) };
  });

  app.post('/api/replay/sessions/:id/step', async request => {
    const session = replaySessions.get((request.params as { id: string }).id);
    if (!session) return { error: 'session_not_found' };
    // Boundary is fixed by the snapshot; stepping a finished session is a no-op.
    if (session.cursor >= session.events.length) { session.status = 'completed'; return { id: session.id, symbol: session.symbol, cursor: session.cursor, status: session.status, event: null, done: true, book: session.book.snapshot(20) }; }
    const event = session.events[session.cursor];
    session.cursor += 1;
    session.book.apply(event);
    session.lastEvent = event;
    session.status = session.cursor >= session.events.length ? 'completed' : 'paused';
    return { id: session.id, symbol: session.symbol, cursor: session.cursor, status: session.status, event, done: session.status === 'completed', book: session.book.snapshot(20) };
  });

  app.post('/api/replay/sessions/:id/run', async request => {
    const session = replaySessions.get((request.params as { id: string }).id);
    if (!session) return { error: 'session_not_found' };
    const body = (request.body ?? {}) as { steps?: number };
    // Clamp against the frozen snapshot only: late events can never extend the run.
    const requested = body.steps ?? session.events.length;
    const steps = Math.max(0, Math.min(requested, session.events.length - session.cursor));
    for (const event of session.events.slice(session.cursor, session.cursor + steps)) session.book.apply(event);
    session.cursor += steps;
    session.status = session.cursor >= session.events.length ? 'completed' : 'paused';
    session.lastEvent = session.events[session.cursor - 1];
    return { id: session.id, symbol: session.symbol, cursor: session.cursor, status: session.status, processed: steps, done: session.status === 'completed', book: session.book.snapshot(20) };
  });

  app.post('/api/sandbox/orders', async request => engine.submitOrder(request.body as { strategyId: string; symbol: string; side: 'buy' | 'sell'; orderType: 'limit' | 'market'; price?: number; quantity: number }));
  app.post('/api/sandbox/cancel', async request => { const body = request.body as { strategyId: string; orderId: string }; return { cancelled: engine.cancel(body.strategyId, body.orderId) }; });
  app.get('/api/sandbox/strategies/:strategyId/performance', async request => engine.performance((request.params as { strategyId: string }).strategyId));
  app.get('/api/sandbox/strategies/:strategyId/events', async request => { const strategyId = (request.params as { strategyId: string }).strategyId; return { orders: engine.anomalies.filter(item => item.detail && (item.detail as { strategyId?: string }).strategyId === strategyId), fills: engine.fills }; });
  app.get('/api/anomalies', async () => engine.anomalies);
  app.get('/api/metrics', async request => { const { symbol = 'ALPHA' } = request.query as { symbol?: string }; return { analytics: engine.analytics(symbol), eventCount: engine.events.length, fillCount: engine.fills.length, anomalyCount: engine.anomalies.length, bookStats: engine.book(symbol).getStats() }; });

  return app;
}
