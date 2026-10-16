/** Status reads do not launch imports. The supervised worker owns upstream requests. */
export function gisIndexProxy({ store = null } = {}) {
  let cached = null,
    expires = 0,
    pending;
  const status = async () => {
    if (cached && Date.now() < expires) return cached;
    if (!pending)
      pending = (
        store
          ? store.status()
          : Promise.resolve({ configured: false, running: false, sources: [] })
      )
        .then((value) => {
          cached = value;
          expires = Date.now() + 5000;
          return value;
        })
        .finally(() => {
          pending = null;
        });
    return pending;
  };
  const install = ({ middlewares, httpServer }) => {
    middlewares.use('/api/locations/index/status', async (req, res) => {
      const send = (code, payload) => {
        res.writeHead(code, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(JSON.stringify(payload));
      };
      if (req.method !== 'GET')
        return send(405, {
          error: 'Use GET. Index controls are managed by the server operator.',
        });
      try {
        send(200, await status());
      } catch {
        send(503, {
          error: 'Address index status is unavailable. Retry shortly.',
        });
      }
    });
    httpServer?.once('close', () => {
      void store?.close().catch(() => {});
    });
  };
  return {
    name: 'gis-index-status',
    configureServer: install,
    configurePreviewServer: install,
  };
}
