import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根目录（apps/server/src → ../../..） */
export const REPO_ROOT = path.resolve(here, '../../..');

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

export const config = {
  port: Number(env('PORT', '3000')),
  databasePath: path.resolve(REPO_ROOT, env('DATABASE_PATH', './data/appeye.sqlite')),
  crawlCron: env('CRAWL_CRON', '0 * * * *'),
  crawlEnabled: env('CRAWL_ENABLED', 'true') === 'true',
  logLevel: env('LOG_LEVEL', 'info'),
  gpThrottleRps: Number(env('GP_THROTTLE_RPS', '4')),
  iosThrottleRps: Number(env('IOS_THROTTLE_RPS', '3')),
  countriesConfigPath: path.resolve(REPO_ROOT, 'config/countries.yaml'),
  webDistPath: path.resolve(REPO_ROOT, 'apps/web/dist'),
} as const;
