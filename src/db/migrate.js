#!/usr/bin/env node
/**
 * Run schema.sql against the configured DATABASE_URL.
 * Usage: npm run db:migrate
 */
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { pool } = require('./index');

async function migrate() {
  const sql = fs.readFileSync(
    path.join(__dirname, '../../sql/schema.sql'),
    'utf8'
  );

  const client = await pool.connect();
  try {
    console.log('[migrate] Running schema.sql …');
    await client.query(sql);
    console.log('[migrate] ✓ Done.');
  } catch (err) {
    console.error('[migrate] ✗ Error:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
