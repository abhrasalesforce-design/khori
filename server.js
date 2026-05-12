require('dotenv').config();
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const path = require('path');
const { initDb, testConnection } = require('./database');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

let sessionStore;
if (process.env.DATABASE_URL) {
  const pgSession = require('connect-pg-simple')(session);
  const { Pool } = require('pg');
  const pgPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  sessionStore = new pgSession({ pool: pgPool, createTableIfMissing: true });
}

app.set('trust proxy', 1);
app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET || 'khori_dev_secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  }
}));
app.use(flash());

app.use('/', require('./routes/auth'));
app.use('/', require('./routes/products'));
app.use('/', require('./routes/cart'));
app.use('/', require('./routes/orders'));
app.use('/admin', require('./routes/admin'));

// One-time admin reset — remove after use
app.get('/setup-admin-khori2026', async (req, res) => {
  const { db } = require('./database');
  const bcrypt = require('bcrypt');
  const hash = await bcrypt.hash('admin123', 10);
  await db.run('DELETE FROM users WHERE email = ?', ['admin@khori.com']);
  await db.run(
    'INSERT INTO users (name, email, password, is_admin) VALUES (?, ?, ?, 1)',
    ['Admin', 'admin@khori.com', hash]
  );
  res.send('Admin account created. Login: admin@khori.com / admin123 — Visit <a href="/login">/login</a>');
});

const PORT = process.env.PORT || 3000;

async function start() {
  await testConnection();
  await initDb();
  await autoSeed();
  app.listen(PORT, () => console.log(`Khori running at http://localhost:${PORT}`));
}

async function autoSeed() {
  const { db } = require('./database');
  const bcrypt = require('bcrypt');

  // Only create admin if not exists
  const existingAdmin = await db.get('SELECT id FROM users WHERE email = ?', ['admin@khori.com']);
  if (!existingAdmin) {
    const hash = await bcrypt.hash('admin123', 10);
    await db.run(
      'INSERT INTO users (name, email, password, is_admin) VALUES (?, ?, ?, 1)',
      ['Admin', 'admin@khori.com', hash]
    );
    console.log('Admin account created: admin@khori.com / admin123');
  }

  // Only seed products if database is completely empty
  const productCount = await db.get('SELECT COUNT(*) as count FROM products');
  if (productCount && productCount.count > 0) {
    console.log(`Skipping seed — ${productCount.count} products already exist.`);
    return;
  }

  const products = [
    ['Hand-painted Clay Pot', 'Beautiful terracotta pot hand-painted with traditional motifs.', 450, 12, 'pottery'],
    ['Macramé Wall Hanging', 'Boho-style macramé wall hanging made with natural cotton rope.', 850, 8, 'textile'],
    ['Beaded Jute Basket', 'Eco-friendly jute basket with hand-stitched beads.', 650, 15, 'basket'],
    ['Brass Wind Chimes', 'Handcrafted brass wind chimes with soothing tones.', 380, 20, 'decor'],
    ['Hand-block Print Tote', 'Cotton tote bag with traditional block print design.', 290, 25, 'textile'],
    ['Carved Wooden Coasters (Set of 4)', 'Set of 4 mango wood coasters with floral carvings.', 520, 10, 'woodwork'],
  ];

  for (const [name, description, price, stock, category] of products) {
    await db.run(
      'INSERT INTO products (name, description, price, stock, category, image) VALUES (?, ?, ?, ?, ?, ?)',
      [name, description, price, stock, category, 'placeholder.jpg']
    );
  }
  console.log('Demo products seeded for first run.');
}

start().catch(err => {
  console.error('Startup failed:', err);
  process.exit(1);
});
