import { Pool } from 'pg';
import { createClient } from 'redis';
import { RedisProjection } from './projection.js';
import { initializeDatabase, LeaderboardRepository } from './repository.js';
import { LeaderboardService } from './service.js';

export async function createRuntime({
  databaseUrl = process.env.DATABASE_URL,
  redisUrl = process.env.REDIS_URL,
  hook,
} = {}) {
  if (!databaseUrl || !redisUrl) throw new Error('DATABASE_URL and REDIS_URL are required');
  const pool = new Pool({ connectionString: databaseUrl, max: 12 });
  const redis = createClient({ url: redisUrl });
  redis.on('error', () => {});
  await redis.connect();
  await initializeDatabase(pool);
  const repository = new LeaderboardRepository(pool);
  const projection = new RedisProjection(redis);
  const service = new LeaderboardService(repository, projection, { hook });
  return {
    pool,
    redis,
    repository,
    projection,
    service,
    async close() {
      if (redis.isOpen) await redis.quit();
      await pool.end();
    },
  };
}
