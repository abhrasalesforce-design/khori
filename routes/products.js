const express = require('express');
const router = express.Router();
const { db } = require('../database');

router.get('/', async (req, res) => {
  const { search, category } = req.query;
  let products;
  if (search) {
    products = await db.all('SELECT * FROM products WHERE name LIKE ? OR description LIKE ?', [`%${search}%`, `%${search}%`]);
  } else if (category) {
    products = await db.all('SELECT * FROM products WHERE category = ?', [category]);
  } else {
    products = await db.all('SELECT * FROM products');
  }
  const catRows = await db.all('SELECT DISTINCT category FROM products');
  const categories = catRows.map(r => r.category);
  res.render('index', { products, categories, search, category, user: req.session.user || null });
});

router.get('/product/:id', async (req, res) => {
  const product = await db.get('SELECT * FROM products WHERE id = ?', [req.params.id]);
  if (!product) return res.redirect('/');
  res.render('product', { product, user: req.session.user || null });
});

module.exports = router;
