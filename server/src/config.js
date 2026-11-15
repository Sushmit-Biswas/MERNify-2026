const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const isProd = process.env.NODE_ENV === 'production';

function secret(name, devDefault) {
  const v = process.env[name];
  if (isProd && v && (v.length < 32 || /^(change-me|dev-only)/i.test(v)))
    throw new Error(`${name} must contain at least 32 characters and cannot be a placeholder`);
  if (v) return v;
  if (isProd) throw new Error(`${name} must be set in production`);
  return devDefault;
}

export const config = {
  isProd,
  port: num(process.env.PORT, 4000),
  host: process.env.HOST || (isProd ? '0.0.0.0' : '127.0.0.1'),
  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/emberwatch',
  jwtSecret: secret('JWT_SECRET', 'dev-only-jwt-secret'),
  jwtTtl: process.env.JWT_TTL || '12h',
  fleetSecret: secret('FLEET_SECRET', 'dev-only-fleet-secret'),
  corsOrigins: (
    process.env.CORS_ORIGINS ||
    'http://localhost:5173,http://127.0.0.1:5173,http://localhost:4000,http://127.0.0.1:4000'
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  demoPassword: process.env.DEMO_PASSWORD || 'ember-demo',

  // Retention
  rawTtlMinutes: num(process.env.RAW_TTL_MINUTES, 15),
  rollupTtlHours: num(process.env.ROLLUP_TTL_HOURS, 24),

  // Ingest protection
  bucketCapacity: num(process.env.BUCKET_CAPACITY, 30),
  bucketRefillPerSec: num(process.env.BUCKET_REFILL, 12),
  gatewayBucketCapacity: num(process.env.GW_BUCKET_CAPACITY, 6000),
  gatewayBucketRefillPerSec: num(process.env.GW_BUCKET_REFILL, 4000),
  queueHighWater: num(process.env.QUEUE_HIGH_WATER, 40000),
  queueHardCap: num(process.env.QUEUE_HARD_CAP, 120000),

  // Pipeline timing
  writeIntervalMs: num(process.env.WRITE_INTERVAL_MS, 500),
  writeBatchMax: num(process.env.WRITE_BATCH_MAX, 8000),
  tickMs: num(process.env.TICK_MS, 250),
  offlineAfterMs: num(process.env.OFFLINE_AFTER_MS, 10000),

  // Embedded simulator for single-service hosting
  simEmbedded: process.env.SIM_EMBEDDED === '1',
  simHz: num(process.env.SIM_HZ, 2),
};
