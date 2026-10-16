import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { apdLinksHandler } from './apd-links.js';
function setup(fetchImpl) {
  const handler = apdLinksHandler({ fetchImpl });
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
test('APD reverse proxy validates identity and sends only its fixed read query', async () => {
  let calls = 0;
  const request = setup(async (url, init) => {
    calls++;
    assert.equal(url, 'https://sdr.alisonaquinas.pro/api/graphql');
    const body = JSON.parse(init.body);
    assert.equal(body.variables.number, '262881726');
    assert.doesNotMatch(body.query, /mutation/);
    assert.match(body.query, /sdrEvents/);
    return Response.json({
      data: {
        apdIncident: {
          incidentNumber: '262881726',
          sdrEvents: [{ eventId: '176' }],
        },
      },
    });
  });
  assert.equal(
    (await request('/?incidentNumber=262881726')).payload.apdIncident
      .sdrEvents[0].eventId,
    '176',
  );
  assert.equal((await request('/?incidentNumber=262881726', 'POST')).code, 405);
  assert.equal((await request('/?incidentNumber=%27%20OR%201=1')).code, 400);
  assert.equal(calls, 1);
});
test('APD reverse proxy exposes import absence and masks GraphQL errors', async () => {
  assert.deepEqual(
    (
      await setup(async () => Response.json({ data: { apdIncident: null } }))(
        '/?incidentNumber=1',
      )
    ).payload,
    { apdIncident: null },
  );
  const result = await setup(async () =>
    Response.json({ errors: [{ message: 'secret database details' }] }),
  )('/?incidentNumber=1');
  assert.equal(result.code, 502);
  assert.doesNotMatch(JSON.stringify(result.payload), /secret/);
});
