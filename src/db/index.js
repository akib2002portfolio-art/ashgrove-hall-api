const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
});

/**
 * Run a query with the pool.
 * @param {string} text  — SQL with $1, $2, … placeholders
 * @param {any[]}  params
 */
const query = (text, params) => pool.query(text, params);

/**
 * Grab a client for multi-statement transactions.
 * Always call client.release() in a finally block.
 */
const getClient = () => pool.connect();

module.exports = { query, getClient, pool };
