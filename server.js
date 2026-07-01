require('dotenv').config();
const express = require('express');
const compression = require('compression');
const session = require('express-session');
const flash = require('connect-flash');
const passport = require('passport');
const path = require('path');
const { initDb, testConnection } = require('./database');
const cookieParser = require('cookie-parser');
const { doubleCsrf } = require('csrf-csrf');

const app = express();

// Gzip all responses
app.use(compression());

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static files — no cache for CSS/JS so updates show immediately, long cache for images
app.use('/images', express.static(path.join(__dirname, 'public/images'), { maxAge: '30d', immutable: true }));
app.use('/css', express.static(path.join(__dirname, 'public/css'), { maxAge: '1h', etag: true }));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads'), { maxAge: '30d', immutable: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Make build version available to all views for cache-busting
app.locals.buildVersion = Date.now();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

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

// Ensure every visitor has a session so CSRF token stays stable across requests
app.use((req, res, next) => {
  if (!req.session.initialized) {
    req.session.initialized = true;
  }
  next();
});

const isProduction = process.env.NODE_ENV === 'production';
const { generateCsrfToken, doubleCsrfProtection, validateRequest } = doubleCsrf({
  getSecret: () => process.env.SESSION_SECRET || 'khori_dev_secret',
  getSessionIdentifier: (req) => req.session?.id || req.sessionID || '',
  cookieName: isProduction ? '__Host-x-csrf-token' : 'x-csrf-token',
  cookieOptions: {
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24, // 24 hours — same as session
  },
  getCsrfTokenFromRequest: (req) =>
    req.body?._csrf || req.headers['x-csrf-token'],
});

// Skip global CSRF check for multipart uploads — multer hasn't parsed the body yet
// so req.body._csrf is unavailable. Those routes verify CSRF manually after multer runs.
app.use((req, res, next) => {
  const isMultipart = (req.headers['content-type'] || '').startsWith('multipart/form-data');
  if (req.method === 'POST' && isMultipart) return next();
  doubleCsrfProtection(req, res, next);
});

// Make CSRF token available to all EJS views
app.use((req, res, next) => {
  res.locals.csrfToken = generateCsrfToken(req, res);
  next();
});

// Expose CSRF validator for routes that run multer before CSRF check
app.locals.validateCsrf = validateRequest;

// Load Google strategy (requires session to be set up first)
require('./routes/auth');

app.use('/', require('./routes/auth'));
app.use('/', require('./routes/products'));
app.use('/', require('./routes/cart'));
app.use('/', require('./routes/orders'));
app.use('/', require('./routes/wishlist'));
app.use('/admin', require('./routes/admin'));
app.use('/admin/invoices', require('./routes/invoices'));
app.use('/reviews', require('./routes/reviews'));

// Contact form — sends email to contact.hathekhori@gmail.com
app.post('/contact', async (req, res) => {
  const { name, email, message } = req.body || {};
  if (!name || !email || !message) return res.status(400).json({ error: 'All fields required' });
  try {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
    });
    await transporter.sendMail({
      from: `"Hathekhori Contact" <${process.env.GMAIL_USER}>`,
      to: 'contact.hathekhori@gmail.com',
      replyTo: email,
      subject: `Message from ${name} via hathekhori.com`,
      text: `Name: ${name}\nEmail: ${email}\n\n${message}`,
      html: `<p><strong>Name:</strong> ${name}</p><p><strong>Email:</strong> ${email}</p><hr><p>${message.replace(/\n/g,'<br>')}</p>`
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('Contact email failed:', err.message);
    res.status(500).json({ error: 'Failed to send' });
  }
});

// CSRF error handler — redirect back with a user-friendly message instead of raw 403
app.use((err, req, res, next) => {
  if (err.code === 'EBADCSRFTOKEN' || err.status === 403 || err.message?.toLowerCase().includes('csrf')) {
    req.flash('error', 'Your session expired. Please try again.');
    return res.redirect('back');
  }
  next(err);
});

// Auto-generated sitemap for Google Search Console
app.get('/sitemap.xml', async (req, res) => {
  const { db } = require('./database');
  const base = 'https://www.hathekhori.com';
  const staticUrls = [
    { loc: '/', priority: '1.0', changefreq: 'daily' },
    { loc: '/about', priority: '0.7', changefreq: 'monthly' },
    { loc: '/collection/wearable-art', priority: '0.9', changefreq: 'weekly' },
    { loc: '/collection/artisan-totes', priority: '0.9', changefreq: 'weekly' },
    { loc: '/collection/canvas-tales', priority: '0.9', changefreq: 'weekly' },
    { loc: '/collection/handmade-treasures', priority: '0.9', changefreq: 'weekly' },
    { loc: '/login', priority: '0.4', changefreq: 'yearly' },
    { loc: '/register', priority: '0.4', changefreq: 'yearly' },
  ];
  const products = await db.all('SELECT id, created_at FROM products ORDER BY id');
  const today = new Date().toISOString().split('T')[0];
  const urls = [
    ...staticUrls.map(u => `  <url>\n    <loc>${base}${u.loc}</loc>\n    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`),
    ...products.map(p => {
      const lastmod = p.created_at ? new Date(p.created_at).toISOString().split('T')[0] : today;
      return `  <url>\n    <loc>${base}/product/${p.id}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.8</priority>\n  </url>`;
    }),
  ];
  res.setHeader('Content-Type', 'application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`);
});

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

  // Upload static images to Cloudinary if credentials are set
  if (process.env.CLOUDINARY_CLOUD_NAME) {
    const { uploadStaticImages } = require('./cloudinary');
    try {
      const staticUrls = await uploadStaticImages();
      // Make CDN URLs available in all EJS views as `cdn`
      app.locals.cdn = staticUrls;
      console.log(`[Cloudinary] ${Object.keys(staticUrls).length} static images on CDN`);
    } catch (err) {
      console.warn('[Cloudinary] Static upload failed, falling back to local:', err.message);
      app.locals.cdn = {};
    }
  } else {
    app.locals.cdn = {};
  }

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
