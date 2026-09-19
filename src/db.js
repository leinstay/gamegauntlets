// mysql2/promise pool for the `gg` database. Importing this module requires
// DB_HOST/DB_NAME/DB_USER to be set — it is not imported by anything that
// needs to work without a database (config parsing, http client, and their
// tests).

import mysql from 'mysql2/promise';
import { env, need } from './config.js';

function createPool(database) {
  return mysql.createPool({
    host: need('DB_HOST'),
    port: Number(env.DB_PORT || 3306),
    user: need('DB_USER'),
    password: env.DB_PASSWORD ?? '',
    database,
    charset: 'utf8mb4',
    dateStrings: true,
    supportBigNumbers: true,
    connectionLimit: 10,
    namedPlaceholders: false,
  });
}

export const pool = createPool(need('DB_NAME'));

export async function query(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

export async function one(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] ?? null;
}

/**
 * Run `fn` inside a transaction on a single dedicated connection. `fn`
 * receives `{ query, one }` bound to that connection (not the pool), so all
 * statements inside it participate in the same transaction. Commits on
 * success, rolls back and rethrows on error, always releases the connection.
 */
export async function tx(fn) {
  const conn = await pool.getConnection();
  const scoped = {
    query: async (sql, params = []) => {
      const [rows] = await conn.query(sql, params);
      return rows;
    },
    one: async (sql, params = []) => {
      const [rows] = await conn.query(sql, params);
      return rows[0] ?? null;
    },
  };
  try {
    await conn.beginTransaction();
    const result = await fn(scoped);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

export async function closePool() {
  await pool.end();
}
