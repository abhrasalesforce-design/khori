const express = require('express');
const router = express.Router();
const { db } = require('../database');

router.get('/', async (req, res) => {
  const { search, category, page, sort } = req.query;

  const ua = req.headers['user-agent'] || '';
  const isMobile = /Mobile|Android|iPhone|iPad|iPod/i.test(ua);
  const perPage = isMobile ? 10 : 20;

  const currentPage = Math.max(1, parseInt(page) || 1);
  const offset = (currentPage - 1) * perPage;

  const orderMap = {
    'price-asc':  'price ASC',
    'price-desc': 'price DESC',
    'name-asc':   'name ASC',
    'name-desc':  'name DESC',
  };
  const orderBy = orderMap[sort] || 'created_at DESC';

  let countSql, dataSql, params;

  if (search) {
    countSql = 'SELECT COUNT(*) as total FROM products WHERE name LIKE ? OR description LIKE ?';
    dataSql  = `SELECT * FROM products WHERE name LIKE ? OR description LIKE ? ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
    params   = [`%${search}%`, `%${search}%`];
  } else if (category) {
    countSql = 'SELECT COUNT(*) as total FROM products WHERE category = ?';
    dataSql  = `SELECT * FROM products WHERE category = ? ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
    params   = [category];
  } else if (!sort) {
    // No filter, no sort — round-robin across categories for a mixed view
    countSql = 'SELECT COUNT(*) as total FROM products';
    dataSql  = `
      WITH ranked AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY category ORDER BY created_at DESC) as rn
        FROM products
      )
      SELECT id, name, description, price, stock, image, category, dimension, material,
             care_instructions, origin, craft_type, created_at
      FROM ranked
      ORDER BY rn, category
      LIMIT ? OFFSET ?`;
    params   = [];
  } else {
    countSql = 'SELECT COUNT(*) as total FROM products';
    dataSql  = `SELECT * FROM products ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
    params   = [];
  }

  const countRow = await db.get(countSql, params);
  const totalProducts = countRow ? countRow.total : 0;
  const totalPages = Math.ceil(totalProducts / perPage);

  const products = await db.all(dataSql, [...params, perPage, offset]);

  const catRows = await db.all('SELECT DISTINCT category FROM products');
  const categories = catRows.map(r => r.category);

  res.render('index', {
    products,
    categories,
    search,
    category,
    sort: sort || null,
    user: req.session.user || null,
    currentPage,
    totalPages,
    perPage
  });
});

router.get('/product/:id', async (req, res) => {
  const product = await db.get('SELECT * FROM products WHERE id = ?', [req.params.id]);
  if (!product) return res.redirect('/');

  // Related products: same category, excluding current
  const relatedProducts = await db.all(
    'SELECT * FROM products WHERE category = ? AND id != ? ORDER BY created_at DESC LIMIT 4',
    [product.category, product.id]
  );

  // Wishlist state for current user
  let isWishlisted = false;
  if (req.session.user) {
    const row = await db.get(
      'SELECT id FROM wishlists WHERE user_id = ? AND product_id = ?',
      [req.session.user.id, product.id]
    );
    isWishlisted = !!row;
  }

  res.render('product', {
    product,
    user: req.session.user || null,
    relatedProducts,
    isWishlisted
  });
});

router.get('/about', (req, res) => {
  res.render('about', { user: req.session.user });
});

router.get('/collection/wearable-art', async (req, res) => {
  const sub = req.query.sub || null;
  const products = sub
    ? await db.all('SELECT * FROM products WHERE category = ? ORDER BY created_at DESC', [sub])
    : await db.all("SELECT * FROM products WHERE category IN ('earrings','pendants','terracotta') ORDER BY created_at DESC");
  res.render('collection-wearable-art', { user: req.session.user || null, products, sub });
});

router.get('/collection/artisan-totes', async (req, res) => {
  const sub = req.query.sub || null;
  const products = sub
    ? await db.all('SELECT * FROM products WHERE category = ? ORDER BY created_at DESC', [sub])
    : await db.all("SELECT * FROM products WHERE category IN ('embroidered','hand-painted') ORDER BY created_at DESC");
  res.render('collection-artisan-totes', { user: req.session.user || null, products, sub });
});

router.get('/collection/canvas-tales', async (req, res) => {
  const sub = req.query.sub || null;
  const products = sub
    ? await db.all('SELECT * FROM products WHERE category = ? ORDER BY created_at DESC', [sub])
    : await db.all("SELECT * FROM products WHERE category IN ('mini-canvas','scenic','mdf') ORDER BY created_at DESC");
  res.render('collection-canvas-tales', { user: req.session.user || null, products, sub });
});

router.get('/collection/handmade-treasures', async (req, res) => {
  const sub = req.query.sub || null;
  const products = sub
    ? await db.all('SELECT * FROM products WHERE category = ? ORDER BY created_at DESC', [sub])
    : await db.all("SELECT * FROM products WHERE category IN ('diaries','keychains','frames','bookmarks') ORDER BY created_at DESC");
  res.render('collection-handmade-treasures', { user: req.session.user || null, products, sub });
});

module.exports = router;
