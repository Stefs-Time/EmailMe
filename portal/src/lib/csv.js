'use strict';

/**
 * CSV writing helpers with spreadsheet formula-injection protection
 * (OWASP "CSV Injection"): cells starting with = + - @ tab or CR are prefixed
 * with a single quote so Excel/Sheets treat them as text.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

function cell(value) {
  if (value === null || value === undefined) return '';
  let s;
  if (value instanceof Date) s = value.toISOString();
  else if (typeof value === 'object') s = JSON.stringify(value);
  else s = String(value);
  if (FORMULA_START.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

function row(values) {
  return values.map(cell).join(',') + '\r\n';
}

/**
 * Streams rows to an Express response as a CSV download.
 * `pages` is an async iterable yielding arrays of row arrays.
 */
async function streamCsv(res, filename, header, pages) {
  const safeName = filename.replace(/[^A-Za-z0-9._-]/g, '_');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.write('﻿'); // BOM so Excel opens UTF-8 correctly
  res.write(row(header));
  for await (const page of pages) {
    let chunk = '';
    for (const r of page) chunk += row(r);
    if (chunk && !res.write(chunk)) {
      await new Promise((resolve) => res.once('drain', resolve));
    }
  }
  res.end();
}

module.exports = { cell, row, streamCsv };
