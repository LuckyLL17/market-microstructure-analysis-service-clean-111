import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { MarketEngine } from './engine.js';
import { MarketEvent } from './types.js';

async function setup() {
  const app = buildApp(new MarketEngine(), false);
  await app.ready();
  const post = (url: string, body?: unknown) => app.inject({ method: 'POST', url, payload: body as never }).then(res => ({ status: res.statusCode, body: res.json() as any }));
  const get = (url: string) => app.inject({ method: 'GET', url }).then(res => res.json() as any);
  return { app, post, get };
}

function lateEvent(sequence: number, timestamp: string): MarketEvent {
  return { id: `LATE-${sequence}`, symbol: 'ALPHA', tradingDay: '2026-09-30', timestamp, sequence, type: 'trade', price: 100.01, quantity: 333, aggressorSide: 'buy' };
}

test('late-arriving events do not cross the session boundary', async () => {
  const { post, get } = await setup();
  const created = await post('/api/replay/sessions', {});
  assert.equal(created.status, 200);
  const { id, eventCount } = created.body;
  assert.equal(eventCount, 13);

  // Mid-session nextEvent points at the frozen sequence.
  const first = await post(`/api/replay/sessions/${id}/step`);
  assert.equal(first.body.cursor, 1);
  assert.equal(first.body.event.id, 'E-1');

  // Late quote for the same trading day arrives after session creation.
  const ingested = await post('/api/market-data/events', lateEvent(14, '2026-09-30T09:30:14.000Z'));
  assert.equal(ingested.body.accepted, true);

  // eventCount / cursor / nextEvent stay on the frozen sequence.
  const view = await get(`/api/replay/sessions/${id}`);
  assert.equal(view.eventCount, 13);
  assert.equal(view.cursor, 1);
  assert.equal(view.nextEvent.id, 'E-2');

  // Run to the frozen end: the late event must not be replayed.
  const run = await post(`/api/replay/sessions/${id}/run`, { steps: 50 });
  assert.equal(run.body.processed, 12);
  assert.equal(run.body.cursor, 13);
  assert.equal(run.body.status, 'completed');
  assert.equal(run.body.done, true);
  assert.equal(run.body.book.sequence, 13);

  // A session created after the late event replays 14 events and diverges.
  const ref = await post('/api/replay/sessions', {});
  assert.equal(ref.body.eventCount, 14);
  const refRun = await post(`/api/replay/sessions/${ref.body.id}/run`, {});
  assert.equal(refRun.body.book.sequence, 14);
  assert.notDeepEqual(refRun.body.book, run.body.book);
});

test('empty session stays empty and complete even after events arrive', async () => {
  const { post, get } = await setup();
  const created = await post('/api/replay/sessions', { symbol: 'GHOST', tradingDay: '2026-09-30' });
  assert.equal(created.body.eventCount, 0);
  assert.equal(created.body.nextEvent, null);

  const step = await post(`/api/replay/sessions/${created.body.id}/step`);
  assert.equal(step.body.done, true);
  assert.equal(step.body.cursor, 0);
  assert.equal(step.body.status, 'completed');

  const run = await post(`/api/replay/sessions/${created.body.id}/run`, { steps: 10 });
  assert.equal(run.body.processed, 0);
  assert.equal(run.body.status, 'completed');

  // GHOST data arriving later still cannot leak into the frozen session.
  await post('/api/market-data/events', { id: 'G-1', symbol: 'GHOST', tradingDay: '2026-09-30', timestamp: '2026-09-30T09:30:00.000Z', sequence: 1, type: 'quote', price: 10, quantity: 5 });
  const view = await get(`/api/replay/sessions/${created.body.id}`);
  assert.equal(view.eventCount, 0);
  assert.equal(view.cursor, 0);
  assert.equal(view.status, 'completed');
  assert.equal(view.progress, 100);
  assert.equal(view.nextEvent, null);
});

test('repeated step/run after completion is idempotent', async () => {
  const { post, get } = await setup();
  const { id } = (await post('/api/replay/sessions', {})).body;

  const finished = await post(`/api/replay/sessions/${id}/run`, {});
  assert.equal(finished.body.processed, 13);
  assert.equal(finished.body.status, 'completed');
  const bookAfterCompletion = JSON.stringify(finished.body.book);

  // Late data lands in the live engine...
  await post('/api/market-data/events', lateEvent(14, '2026-09-30T09:30:14.000Z'));

  // ...but repeated step/run must neither move the cursor nor touch the book.
  const extraStep = await post(`/api/replay/sessions/${id}/step`);
  assert.equal(extraStep.body.done, true);
  assert.equal(extraStep.body.cursor, 13);
  assert.equal(extraStep.body.event, null);
  assert.equal(JSON.stringify(extraStep.body.book), bookAfterCompletion);

  const extraRun = await post(`/api/replay/sessions/${id}/run`, { steps: 5 });
  assert.equal(extraRun.body.processed, 0);
  assert.equal(extraRun.body.cursor, 13);
  assert.equal(JSON.stringify(extraRun.body.book), bookAfterCompletion);

  const view = await get(`/api/replay/sessions/${id}`);
  assert.equal(view.cursor, 13);
  assert.equal(view.eventCount, 13);
  assert.equal(view.status, 'completed');
  assert.equal(view.nextEvent, null);
});

test('two interleaved sessions keep independent frozen boundaries', async () => {
  const { post, get } = await setup();
  const sessionA = (await post('/api/replay/sessions', { speed: 1 })).body;
  const sessionB = (await post('/api/replay/sessions', { speed: 2 })).body;
  assert.notEqual(sessionA.id, sessionB.id);

  // Advance A a little while B stays ready.
  await post(`/api/replay/sessions/${sessionA.id}/step`);
  await post(`/api/replay/sessions/${sessionA.id}/step`);

  // A late event arrives; only sessions created afterwards can see it.
  await post('/api/market-data/events', lateEvent(14, '2026-09-30T09:30:14.000Z'));

  const sessionC = (await post('/api/replay/sessions', {})).body;
  assert.equal(sessionA.eventCount, 13);
  assert.equal(sessionB.eventCount, 13);
  assert.equal(sessionC.eventCount, 14);

  // Interleave step/run across A and B; both stay inside their own snapshot.
  const stepA3 = await post(`/api/replay/sessions/${sessionA.id}/step`);
  assert.equal(stepA3.body.event.id, 'E-3');
  const runB = await post(`/api/replay/sessions/${sessionB.id}/run`, { steps: 3 });
  assert.equal(runB.body.cursor, 3);
  assert.equal(runB.body.status, 'paused');
  assert.equal(runB.body.book.sequence, 3);
  const stepA4 = await post(`/api/replay/sessions/${sessionA.id}/step`);
  assert.equal(stepA4.body.event.id, 'E-4');

  const doneA = await post(`/api/replay/sessions/${sessionA.id}/run`, {});
  assert.equal(doneA.body.processed, 9);
  assert.equal(doneA.body.cursor, 13);
  assert.equal(doneA.body.status, 'completed');

  const viewB = await get(`/api/replay/sessions/${sessionB.id}`);
  assert.equal(viewB.cursor, 3);
  assert.equal(viewB.status, 'paused');
  assert.equal(viewB.nextEvent.id, 'E-4');

  // C includes the late event as the last element of its own frozen sequence.
  const doneC = await post(`/api/replay/sessions/${sessionC.id}/run`, {});
  assert.equal(doneC.body.processed, 14);
  assert.equal(doneC.body.status, 'completed');
  assert.equal(doneC.body.book.sequence, 14);
  assert.notDeepEqual(doneC.body.book, doneA.body.book);
});

test('events appended after completion remain visible to live data path', async () => {
  const { post, get } = await setup();
  const { id } = (await post('/api/replay/sessions', {})).body;
  await post(`/api/replay/sessions/${id}/run`, {});

  // Live orderbook state before the late event.
  const liveBefore = await get('/api/metrics?symbol=ALPHA');
  assert.equal(liveBefore.eventCount, 13);
  const tradeCountBefore = liveBefore.bookStats.tradeCount;

  await post('/api/market-data/events', lateEvent(14, '2026-09-30T09:30:14.000Z'));

  // Live ingestion path is unaffected.
  const liveAfter = await get('/api/metrics?symbol=ALPHA');
  assert.equal(liveAfter.eventCount, 14);
  assert.equal(liveAfter.bookStats.tradeCount, tradeCountBefore + 1);

  // Completed replay session is unaffected.
  const view = await get(`/api/replay/sessions/${id}`);
  assert.equal(view.eventCount, 13);
  assert.equal(view.cursor, 13);
  assert.equal(view.status, 'completed');

  // A fresh session created afterwards picks the appended event up.
  const fresh = await post('/api/replay/sessions', {});
  assert.equal(fresh.body.eventCount, 14);
});
