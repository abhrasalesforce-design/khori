const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { db } = require('../database');

// ── Google OAuth Strategy ──────────────────────────────────────────────────
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID:     process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL:  process.env.GOOGLE_CALLBACK_URL || '/auth/google/callback'
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      const email = profile.emails[0].value;
      const name  = profile.displayName;
      let user = await db.get('SELECT * FROM users WHERE google_id = ?', [profile.id]);
      if (!user) {
        user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
        if (user) {
          await db.run('UPDATE users SET google_id = ? WHERE id = ?', [profile.id, user.id]);
        } else {
          await db.run(
            'INSERT INTO users (name, email, google_id) VALUES (?, ?, ?)',
            [name, email, profile.id]
          );
          user = await db.get('SELECT * FROM users WHERE google_id = ?', [profile.id]);
        }
      }
      return done(null, user);
    } catch (err) {
      return done(err);
    }
  }));

  passport.serializeUser((user, done) => done(null, user.id));
  passport.deserializeUser(async (id, done) => {
    const user = await db.get('SELECT * FROM users WHERE id = ?', [id]);
    done(null, user);
  });
}

// ── Email / Password routes ────────────────────────────────────────────────
router.get('/login', (req, res) => {
  res.render('login', {
    error: req.flash('error'),
    success: req.flash('success'),
    user: req.session.user || null,
    googleEnabled: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
  });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
  if (!user || !user.password || !(await bcrypt.compare(password, user.password))) {
    req.flash('error', 'Invalid email or password.');
    return res.redirect('/login');
  }
  req.session.user = { id: user.id, name: user.name, email: user.email, is_admin: user.is_admin };
  res.redirect(user.is_admin ? '/admin' : '/');
});

router.get('/register', (req, res) => {
  res.render('register', {
    error: req.flash('error'),
    user: req.session.user || null,
    googleEnabled: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
  });
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

// ── Google OAuth routes ────────────────────────────────────────────────────
router.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

router.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login', session: false }),
  (req, res) => {
    req.session.user = {
      id: req.user.id,
      name: req.user.name,
      email: req.user.email,
      is_admin: req.user.is_admin
    };
    res.redirect(req.user.is_admin ? '/admin' : '/');
  }
);

module.exports = router;
