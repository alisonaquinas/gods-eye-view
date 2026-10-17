#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { GisIndexStore } from '../server/providers/gis-index/store.js';
import { importPlaces } from '../server/providers/place-registry/store.js';

const [command, path, ...extra] = process.argv.slice(2);
if (command !== 'import' || !path || extra.length)
  throw new Error('Use places.mjs import path/to/catalog.json.');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
if ((await stat(path)).size > 2 * 1024 * 1024)
  throw new Error('Place catalogs are limited to 2 MiB.');
const dataset = JSON.parse(await readFile(path, 'utf8'));
const store = new GisIndexStore(process.env.DATABASE_URL, {
  schema: process.env.GEV_GIS_SCHEMA || 'public',
});
try {
  console.log(JSON.stringify(await importPlaces(store, dataset)));
} finally {
  await store.close();
}
