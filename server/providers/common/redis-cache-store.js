import { createClient } from '@redis/client';

// Both keys share a hash tag. Reading the response and claiming the refresh
// happen atomically, including when another process finishes between polls.
const CLAIM = `
local cached = redis.call('GET', KEYS[1])
if cached then return {'hit', cached, tostring(redis.call('PTTL', KEYS[1]))} end
if redis.call('SET', KEYS[2], ARGV[1], 'NX', 'PX', ARGV[2]) then return {'owner'} end
return {'wait'}
`;
const FINISH = `
if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
if tonumber(ARGV[3]) > 0 then redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3]) end
redis.call('DEL', KEYS[2])
return 1
`;
const READ = `return redis.call('GET', KEYS[1])`;
const REFRESH = `return redis.call('SET', KEYS[2], ARGV[1], 'NX', 'PX', ARGV[2])`;

/** One lazy connection per app; bounded commands never queue through outages. */
export function createRedisCacheStore({ url, prefix }) {
  let client;
  let connecting;
  let retryAt = 0;
  async function connection() {
    if (client?.isReady) return client;
    if (connecting) return connecting;
    if (Date.now() < retryAt) throw new Error('API cache unavailable');
    if (client?.isOpen) client.destroy();
    client = createClient({
      url,
      disableOfflineQueue: true,
      socket: { connectTimeout: 2_000, reconnectStrategy: false },
    });
    // Never log Redis URLs or raw errors, which can contain credentials.
    client.on('error', () => {});
    connecting = client
      .connect()
      .then(() => {
        return client;
      })
      .catch(() => {
        retryAt = Date.now() + 2_000;
        throw new Error('API cache unavailable');
      })
      .finally(() => {
        connecting = undefined;
      });
    return connecting;
  }
  const keys = (key) => [
    `${prefix}{${key}}:response`,
    `${prefix}{${key}}:lock`,
  ];
  async function evaluate(script, key, args) {
    try {
      const redis = await connection();
      return await redis.withCommandOptions({ timeout: 2_000 }).eval(script, {
        keys: keys(key),
        arguments: args.map(String),
      });
    } catch {
      throw Object.assign(new Error('API response cache unavailable'), {
        code: 'API_CACHE_UNAVAILABLE',
      });
    }
  }
  return {
    async read(key) {
      return evaluate(READ, key, []);
    },
    async claimRefresh(key, token, leaseMs) {
      return Boolean(await evaluate(REFRESH, key, [token, leaseMs]));
    },
    async claim(key, token, leaseMs) {
      const [state, value, ttl] = await evaluate(CLAIM, key, [token, leaseMs]);
      return { state, value, ttlMs: Number(ttl) };
    },
    async finish(key, token, value, ttlMs) {
      return Boolean(await evaluate(FINISH, key, [token, value, ttlMs]));
    },
    close() {
      if (client?.isOpen) client.destroy();
      client = undefined;
    },
  };
}
