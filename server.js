require('dotenv').config();
const express = require('express');
const compression = require('compression');
const session = require('express-session');
const flash = require('connect-flash');
const passport = require('passport');
const path = require('path');
const { initDb, testConnection } = require('./database');

const app = express();

// Gzip all responses
app.use(compression());

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static files with long cache for images/fonts/css/js
app.use('/images', express.static(path.join(__dirname, 'public/images'), { maxAge: '30d', immutable: true }));
app.use('/css', express.static(path.join(__dirname, 'public/css'), { maxAge: '7d' }));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads'), { maxAge: '30d', immutable: true }));
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
app.use(passport.initialize());

// Load Google strategy (requires session to be set up first)
require('./routes/auth');

app.use('/', require('./routes/auth'));
app.use('/', require('./routes/products'));
app.use('/', require('./routes/cart'));
app.use('/', require('./routes/orders'));
app.use('/', require('./routes/wishlist'));
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
    ['Brass Wind Chime — Lotus', 'A delicately handcrafted brass wind chime inspired by the lotus flower. Each piece is individually cast and polished by artisans in West Bengal, producing a soft, resonant tone that fills any room with calm. Perfect for doorways, balconies, or as a centrepiece in a meditation corner.', 480, 15, 'decor', null],
    ['Hand-painted Terracotta Diya Set', 'A set of six terracotta diyas hand-painted with vibrant floral and paisley motifs in natural pigments. Fired in traditional earth kilns, these oil lamps carry the warmth of Bengali craft traditions. Ideal for festivals, daily puja, or home decor.', 320, 20, 'decor', 'Each diya: 6 cm diameter x 3 cm height'],
    ['Jute & Cane Storage Basket', 'Woven by hand using sustainably sourced jute and cane in a centuries-old interlocking pattern from Assam. Sturdy enough for everyday storage yet beautiful enough to display on a shelf. Comes with a removable cotton lining in a natural cream tone.', 750, 12, 'decor', '28 cm diameter x 22 cm height'],
    ['Madhubani Painted Wall Frame', 'A hand-painted Madhubani artwork on handmade cotton rag paper, mounted in a natural mango wood frame. The motif depicts the sacred fish — a traditional symbol of fertility and good fortune — rendered in vivid mineral pigments. Each piece is one of a kind.', 1200, 8, 'decor', 'Frame: 25 cm x 30 cm'],
    ['Carved Wooden Incense Holder', 'Turned on a lathe from seasoned sheesham wood and hand-carved with vine-and-leaf patterns. Holds standard incense sticks and cones, with a catch tray for ash. The natural oils in sheesham wood lend a warm, deep lustre that deepens with age.', 390, 18, 'decor', '22 cm x 5 cm x 4 cm'],
    ['Macrame Cotton Wall Hanging', 'Knotted by hand from unbleached natural cotton rope in a traditional diamond and fringe pattern. A single piece can transform a bare wall into a textured artisanal statement. Each knot is tied individually — no machines, no shortcuts.', 950, 10, 'textile', '45 cm wide x 70 cm long'],
    ['Beaded Jute Basket', 'An eco-friendly storage basket woven from thick jute twine and finished with rows of hand-stitched ceramic beads along the rim, glazed in soft earth tones — ivory, terracotta, and sage — that complement any interior palette.', 680, 14, 'basket', '24 cm diameter x 18 cm height'],
    ['Hand-block Print Tote Bag', 'Stitched from thick, undyed cotton canvas and stamped by hand with a vintage floral block-print design using natural indigo dye. Reinforced handles and an inner pocket make this as practical as it is beautiful.', 340, 25, 'textile', '38 cm x 42 cm, handle drop 28 cm'],
    ['Hand-painted Clay Pot', 'A rounded terracotta pot wheel-thrown from river clay and decorated with traditional geometric and floral motifs in iron oxide, white slip, and natural pigments. Suitable for small plants, as a pencil holder, or purely as a decorative object.', 460, 12, 'pottery', '14 cm diameter x 16 cm height'],
    ['Carved Wooden Coasters Set of 4', 'Four coasters cut from thick mango wood and hand-carved with a radiating sunflower pattern. Each coaster is slightly different, reflecting the natural grain of the wood. Finished with food-safe beeswax — no lacquer, no plastic coating.', 540, 10, 'woodwork', 'Each coaster: 10 cm diameter x 1.2 cm thick'],
  ];

  for (const [name, description, price, stock, category, dimension] of products) {
    await db.run(
      'INSERT INTO products (name, description, price, stock, category, image, dimension) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [name, description, price, stock, category, 'placeholder.jpg', dimension]
    );
  }
  console.log('Demo products seeded for first run.');
}

start().catch(err => {
  console.error('Startup failed:', err);
  process.exit(1);
});
