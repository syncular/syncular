import { join } from 'node:path';
import { config } from 'dotenv';

const res = config({
  path: join(__dirname, '.env'),
});

const parsed = res.parsed as Record<string, string>;
parsed.NODE_ENV = process.env.NODE_ENV || parsed.NODE_ENV;
export const env = parsed;
