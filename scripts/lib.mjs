// Small helpers shared by fetch, validate and publish.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const path = (...p) => join(ROOT, ...p);

// Today's date in India (YYYY-MM-DD). IST has no daylight saving, so a fixed +05:30 is exact.
export function istDate(d = new Date()) {
  return new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

export function istTimestamp(d = new Date()) {
  return new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 19) + '+05:30';
}

export function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (fallback !== undefined && err.code === 'ENOENT') return fallback;
    throw err;
  }
}

export async function writeJson(file, data) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2) + '\n');
}

// Canonical form of a URL for duplicate checks: no hash, no tracking params, no trailing slash.
export function normUrl(u) {
  try {
    const url = new URL(u);
    url.hash = '';
    for (const k of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|oc$|amp$)/i.test(k)) url.searchParams.delete(k);
    }
    url.hostname = url.hostname.toLowerCase();
    return url.toString().replace(/\/(?=$|\?)/, '');
  } catch {
    return String(u || '').trim();
  }
}

// Numbers as they appear in text: "1,29,900" -> "129900", "3.37" stays "3.37".
export function numbersIn(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    let n = m[0].replace(/,/g, '').replace(/\.$/, '');
    if (n.includes('.')) n = n.replace(/0+$/, '').replace(/\.$/, '');
    out.add(n);
  }
  return out;
}

export function wordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}
