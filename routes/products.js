const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { getDiscountMap, applyDiscount } = require('./cartPricing');

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

  let products, totalProducts;

  if (search) {
    countSql = 'SELECT COUNT(*) as total FROM products WHERE name LIKE ? OR description LIKE ?';
    dataSql  = `SELECT * FROM products WHERE name LIKE ? OR description LIKE ? ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
    params   = [`%${search}%`, `%${search}%`];
    const countRow = await db.get(countSql, params);
    totalProducts = countRow ? countRow.total : 0;
    products = await db.all(dataSql, [...params, perPage, offset]);
  } else if (category === 'hand-made-jewelry') {
    const jewelryCats = ['earrings', 'pendants', 'terracotta'];
    const placeholders = jewelryCats.map(() => '?').join(',');
    countSql = `SELECT COUNT(*) as total FROM products WHERE category IN (${placeholders})`;
    dataSql  = `SELECT * FROM products WHERE category IN (${placeholders}) ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
    params   = jewelryCats;
    const countRow = await db.get(countSql, params);
    totalProducts = countRow ? countRow.total : 0;
    products = await db.all(dataSql, [...params, perPage, offset]);
  } else if (category === 'hand-painted-tote-bags') {
    countSql = 'SELECT COUNT(*) as total FROM products WHERE category = ?';
    dataSql  = `SELECT * FROM products WHERE category = ? ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
    params   = ['hand-painted'];
    const countRow = await db.get(countSql, params);
    totalProducts = countRow ? countRow.total : 0;
    products = await db.all(dataSql, [...params, perPage, offset]);
  } else if (category === 'mini-canvas-art-work') {
    const canvasCats = ['mini-canvas', 'scenic'];
    const placeholders = canvasCats.map(() => '?').join(',');
    countSql = `SELECT COUNT(*) as total FROM products WHERE category IN (${placeholders})`;
    dataSql  = `SELECT * FROM products WHERE category IN (${placeholders}) ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
    params   = canvasCats;
    const countRow = await db.get(countSql, params);
    totalProducts = countRow ? countRow.total : 0;
    products = await db.all(dataSql, [...params, perPage, offset]);
  } else if (category) {
    countSql = 'SELECT COUNT(*) as total FROM products WHERE category = ?';
    dataSql  = `SELECT * FROM products WHERE category = ? ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
    params   = [category];
    const countRow = await db.get(countSql, params);
    totalProducts = countRow ? countRow.total : 0;
    products = await db.all(dataSql, [...params, perPage, offset]);
  } else if (!sort) {
    // Round-robin across all categories, reshuffled on every request
    const allProducts = await db.all('SELECT * FROM products ORDER BY RANDOM()');
    totalProducts = allProducts.length;
    // Group by category preserving random order
    const byCategory = {};
    for (const p of allProducts) {
      if (!byCategory[p.category]) byCategory[p.category] = [];
      byCategory[p.category].push(p);
    }
    // Interleave: one from each category per round
    const interleaved = [];
    const pools = Object.values(byCategory);
    const maxLen = Math.max(...pools.map(a => a.length));
    for (let i = 0; i < maxLen; i++) {
      for (const pool of pools) {
        if (pool[i]) interleaved.push(pool[i]);
      }
    }
    products = interleaved.slice(offset, offset + perPage);
  } else {
    countSql = 'SELECT COUNT(*) as total FROM products';
    dataSql  = `SELECT * FROM products ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
    params   = [];
    const countRow = await db.get(countSql, params);
    totalProducts = countRow ? countRow.total : 0;
    products = await db.all(dataSql, [...params, perPage, offset]);
  }

  const totalPages = Math.ceil(totalProducts / perPage);

  const catRows = await db.all('SELECT DISTINCT category FROM products');
  const rawCats = catRows.map(r => r.category);

  const jewelrySet  = new Set(['earrings', 'pendants', 'terracotta']);
  const toteSet     = new Set(['hand-painted']);
  const canvasSet   = new Set(['mini-canvas', 'scenic']);

  const suppressedSet = new Set([...jewelrySet, ...toteSet, ...canvasSet]);
  const baseCategories = rawCats.filter(c => !suppressedSet.has(c));

  if (rawCats.some(c => jewelrySet.has(c)))  baseCategories.push('hand-made-jewelry');
  if (rawCats.some(c => toteSet.has(c)))     baseCategories.push('hand-painted-tote-bags');
  if (rawCats.some(c => canvasSet.has(c)))   baseCategories.push('mini-canvas-art-work');

  const categories = baseCategories;

  const lcpImageUrl = (req.app.locals.cdn && req.app.locals.cdn['mini-canvas.jpg']) || '/images/mini-canvas.jpg';
  const slides = await db.all('SELECT * FROM banners WHERE active = 1 ORDER BY sort_order ASC, id ASC');
  const discountMap = await getDiscountMap();
  res.render('index', {
    lcpImageUrl,
    products,
    categories,
    search,
    category,
    sort: sort || null,
    user: req.session.user || null,
    currentPage,
    totalPages,
    perPage,
    slides,
    discountMap,
    applyDiscount
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

  const discountMap = await getDiscountMap();
  res.render('product', {
    product,
    user: req.session.user || null,
    relatedProducts,
    isWishlisted,
    discountMap,
    applyDiscount
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
  const discountMap = await getDiscountMap();
  res.render('collection-wearable-art', { user: req.session.user || null, products, sub, discountMap, applyDiscount });
});

router.get('/collection/artisan-totes', async (req, res) => {
  const sub = req.query.sub || null;
  const products = sub
    ? await db.all('SELECT * FROM products WHERE category = ? ORDER BY created_at DESC', [sub])
    : await db.all("SELECT * FROM products WHERE category IN ('embroidered','hand-painted') ORDER BY created_at DESC");
  const discountMap = await getDiscountMap();
  res.render('collection-artisan-totes', { user: req.session.user || null, products, sub, discountMap, applyDiscount });
});

router.get('/collection/canvas-tales', async (req, res) => {
  const sub = req.query.sub || null;
  const products = sub
    ? await db.all('SELECT * FROM products WHERE category = ? ORDER BY created_at DESC', [sub])
    : await db.all("SELECT * FROM products WHERE category IN ('mini-canvas','scenic','mdf') ORDER BY created_at DESC");
  const discountMap = await getDiscountMap();
  res.render('collection-canvas-tales', { user: req.session.user || null, products, sub, discountMap, applyDiscount });
});

router.get('/collection/handmade-treasures', async (req, res) => {
  const sub = req.query.sub || null;
  const products = sub
    ? await db.all('SELECT * FROM products WHERE category = ? ORDER BY created_at DESC', [sub])
    : await db.all("SELECT * FROM products WHERE category IN ('diaries','keychains','frames','bookmarks') ORDER BY created_at DESC");
  const discountMap = await getDiscountMap();
  res.render('collection-handmade-treasures', { user: req.session.user || null, products, sub, discountMap, applyDiscount });
});

module.exports = router;
