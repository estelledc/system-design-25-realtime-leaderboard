import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createHandler } from '../../src/http.js';

async function withServer(service, callback, events = []) {
  const server = createServer(createHandler(service, { logger: (event) => events.push(event) }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('HTTP route returns service result and low-cardinality telemetry', async () => {
  const events = [];
  const service = {
    async state() {
      return { status: 200, events: 3, published_publications: 1 };
    },
  };
  await withServer(service, async (base) => {
    const response = await fetch(`${base}/v1/state`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { events: 3, published_publications: 1 });
  }, events);
  assert.deepEqual(events, [{ operation: 'state', outcome: 'ok', status: 200 }]);
});

test('unknown dependency errors are sanitized', async () => {
  const events = [];
  const service = {
    async state() {
      throw new Error('postgres://secret@host player-real score=999');
    },
  };
  await withServer(service, async (base) => {
    const response = await fetch(`${base}/v1/state`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: { code: 'dependency_unavailable', message: 'dependency unavailable' },
    });
  }, events);
  assert.deepEqual(events, [{ operation: 'state', outcome: 'dependency_unavailable', status: 503 }]);
});

test('HTTP rejects an oversized body before service mutation', async () => {
  let called = false;
  const service = {
    async reportScore() {
      called = true;
      return { status: 201 };
    },
  };
  await withServer(service, async (base) => {
    const response = await fetch(`${base}/v1/score-events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(17 * 1024) }),
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error.code, 'body_too_large');
  });
  assert.equal(called, false);
});
