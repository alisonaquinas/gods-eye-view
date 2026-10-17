import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { p25EventsProxy } from '../../server/providers/p25-events.js';

function setup(fetchImpl) {
  let handler;
  p25EventsProxy({ fetchImpl }).configureServer({
    middlewares: {
      use(_path, fn) {
        if (_path === '/api/p25-events') handler = fn;
      },
    },
  });
  return async (url, method = 'GET') => {
    const res = new EventEmitter();
    let code, payload;
    res.writeHead = (status) => {
      code = status;
    };
    res.end = (body) => {
      payload = JSON.parse(body);
    };
    await handler(
      { url, method, headers: {}, socket: { remoteAddress: '127.0.0.1' } },
      res,
    );
    return { code, payload };
  };
}
const path = '/?from=2026-10-15T12:00:00Z&until=2026-10-15T18:00:00Z';
test('proxy only sends a fixed read query with validated bounds and no browser credentials', async () => {
  const request = setup(async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.match(body.query, /^query GevP25Events/);
    assert.match(body.query, /organizations\s*\{\s*id name aliases\s*\}/);
    assert.equal(body.variables.filter.origin, 'RADIO');
    assert.match(body.query, /id origin timestamp/);
    assert.equal(body.variables.filter.from, '2026-10-15T12:00:00.000Z');
    assert.equal(init.headers['X-Vector-Control'], '1');
    assert.equal(init.redirect, 'error');
    return Response.json({
      data: { eventLogEntries: { entries: [], total: 0, next: null } },
    });
  });
  assert.equal((await request(path)).code, 200);
  assert.equal((await request(path, 'POST')).code, 405);
  assert.equal((await request('/?from=nope&until=nope')).code, 400);
  assert.equal((await request(`${path}&before=mutation`)).code, 400);
});
test('proxy preserves event organization tags from SDR', async () => {
  const entry = {
    id: '3',
    organizations: [
      { id: '7', name: 'Atlanta Fire Rescue Department', aliases: ['AFD'] },
    ],
  };
  const request = setup(async () =>
    Response.json({
      data: { eventLogEntries: { entries: [entry], total: 1, next: null } },
    }),
  );
  const result = await request(path);
  assert.equal(result.code, 200);
  assert.deepEqual(result.payload.entries, [entry]);
});
test('HTTP-200 GraphQL errors are reported as failures without leaking upstream detail', async () => {
  const request = setup(async () =>
    Response.json({ errors: [{ message: 'Internal SQL details' }] }),
  );
  const result = await request(path);
  assert.equal(result.code, 502);
  assert.doesNotMatch(result.payload.error, /SQL/);
});
