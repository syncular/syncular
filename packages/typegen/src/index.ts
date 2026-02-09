/**
 * @syncular/typegen - Generate TypeScript types from migrations
 *
 * Creates type definitions by:
 * 1. Applying migrations to an in-memory database (SQLite or PostgreSQL)
 * 2. Introspecting the resulting schema
 * 3. Generating TypeScript interfaces
 */

export * from './generate';
export * from './introspect';
export * from './map-types';
export * from './render';
export * from './types';
