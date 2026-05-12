const { Pool } = require('pg');
const Database = require('better-sqlite3');
const path = require('path');

// Use PostgreSQL on Railway (DATABASE_URL set automatically), SQLite locally
const isPostgres = !!process.env.DATABASE_URL;
console.log('DATABASE MODE:', isPostgres ? 'PostgreSQL ✅' : 'SQLite ⚠️ (data will not persist on Railway)');

let pool;
let sqliteDb;

if (isPostgres) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    max: 5
  });
  pool.on('error', (err) => console.error('PostgreSQL pool error:', err.message));
} else {
  sqliteDb = new Database(path.join(__dirname, 'khori.db'));
}

async function testConnection() {
  if (!isPostgres) return;
  try {
    const client = await pool.connect();
    console.log('PostgreSQL connected successfully ✅');
    client.release();
  } catch (err) {
    console.error('PostgreSQL connection failed ❌:', err.message);
    console.error('DATABASE_URL starts with:', process.env.DATABASE_URL?.substring(0, 30));
  }
}

async function initDb() {
  const schema = `
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      is_admin INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      price REAL NOT NULL,
      stock INTEGER DEFAULT 0,
      image TEXT DEFAULT 'placeholder.jpg',
      category TEXT DEFAULT 'general',
      dimension TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      user_id INTEGER,
      total REAL NOT NULL,
      status TEXT DEFAULT 'pending',
      paypal_order_id TEXT,
      name TEXT,
      email TEXT,
      address TEXT,
      city TEXT,
      zip TEXT,
      country TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS order_items (
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      price REAL NOT NULL,
      FOREIGN KEY (order_id) REFERENCES orders(id),
      FOREIGN KEY (product_id) REFERENCES products(id)
    );
  `;

  if (isPostgres) {
    await pool.query(schema);
    // Add dimension column if it doesn't exist (safe migration)
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS dimension TEXT`);
  } else {
    sqliteDb.exec(schema.replace(/SERIAL PRIMARY KEY/g, 'INTEGER PRIMARY KEY AUTOINCREMENT').replace(/TIMESTAMP/g, 'DATETIME'));
    // Add dimension column to SQLite if missing
    try { sqliteDb.exec(`ALTER TABLE products ADD COLUMN dimension TEXT`); } catch (_) {}
  }
}

// Unified query interface
const db = {
  // Returns all rows
  all: async (sql, params = []) => {
    if (isPostgres) {
      const pgSql = toPostgres(sql);
      const res = await pool.query(pgSql, params);
      return res.rows;
    }
    return sqliteDb.prepare(sql).all(...params);
  },
  // Returns single row
  get: async (sql, params = []) => {
    if (isPostgres) {
      const pgSql = toPostgres(sql);
      const res = await pool.query(pgSql, params);
      return res.rows[0] || null;
    }
    return sqliteDb.prepare(sql).get(...params) || null;
  },
  // Returns { lastInsertRowid, changes }
  run: async (sql, params = []) => {
    if (isPostgres) {
      let pgSql = toPostgres(sql);
      const isInsert = /^\s*INSERT/i.test(pgSql);
      if (isInsert) pgSql += ' RETURNING id';
      const res = await pool.query(pgSql, params);
      return { lastInsertRowid: isInsert ? res.rows[0]?.id : null, changes: res.rowCount };
    }
    const result = sqliteDb.prepare(sql).run(...params);
    return { lastInsertRowid: result.lastInsertRowid, changes: result.changes };
  }
};

// Convert SQLite ? placeholders to PostgreSQL $1, $2...
function toPostgres(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

module.exports = { db, initDb, testConnection };
