const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { db } = require('../database');

router.get('/login', (req, res) => {
  res.render('login', { error: req.flash('error'), success: req.flash('success'), user: req.session.user || null });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
  if (!user || !(await bcrypt.compare(password, user.password))) {
    req.flash('error', 'Invalid email or password.');
    return res.redirect('/login');
  }
  req.session.user = { id: user.id, name: user.name, email: user.email, is_admin: user.is_admin };
  res.redirect(user.is_admin ? '/admin' : '/');
});

router.get('/register', (req, res) => {
  res.render('register', { error: req.flash('error'), user: req.session.user || null });
});

router.post('/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    req.flash('error', 'All fields are required.');
    return res.redirect('/register');
  }
  const existing = await db.get('SELECT id FROM users WHERE email = ?', [email]);
  if (existing) {
    req.flash('error', 'Email already registered.');
    return res.redirect('/register');
  }
  const hash = await bcrypt.hash(password, 10);
  await db.run('INSERT INTO users (name, email, password) VALUES (?, ?, ?)', [name, email, hash]);
  req.flash('success', 'Account created! Please log in.');
  res.redirect('/login');
});

router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

module.exports = router;
