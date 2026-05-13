const express = require('express');
const router = express.Router();
const { db } = require('../database');

router.get('/', async (req, res) => {
  const { search, category, page } = req.query;

  // Detect mobile via User-Agent — server-side page size decision
  const ua = req.headers['user-agent'] || '';
  const isMobile = /Mobile|Android|iPhone|iPad|iPod/i.test(ua);
  const perPage = isMobile ? 10 : 30;

  const currentPage = Math.max(1, parseInt(page) || 1);
  const offset = (currentPage - 1) * perPage;

  let countSql, dataSql, params;

  if (search) {
    countSql = 'SELECT COUNT(*) as total FROM products WHERE name LIKE ? OR description LIKE ?';
    dataSql  = 'SELECT * FROM products WHERE name LIKE ? OR description LIKE ? ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params   = [`%${search}%`, `%${search}%`];
  } else if (category) {
    countSql = 'SELECT COUNT(*) as total FROM products WHERE category = ?';
    dataSql  = 'SELECT * FROM products WHERE category = ? ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params   = [category];
  } else {
    countSql = 'SELECT COUNT(*) as total FROM products';
    dataSql  = 'SELECT * FROM products ORDER BY created_at DESC LIMIT ? OFFSET ?';
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
    user: req.session.user || null,
    currentPage,
    totalPages,
    perPage
  });
});

router.get('/product/:id', async (req, res) => {
  const product = await db.get('SELECT * FROM products WHERE id = ?', [req.params.id]);
  if (!product) return res.redirect('/');
  res.render('product', { product, user: req.session.user || null });
});

module.exports = router;
