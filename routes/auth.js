const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { rateLimit } = require('express-rate-limit');
const { db } = require('../database');

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many attempts. Please try again in 15 minutes.',
  standardHeaders: true,
  legacyHeaders: false,
});

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

router.post('/login', authLimiter, async (req, res) => {
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

router.post('/register', authLimiter, async (req, res) => {
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

// ── Forgot Password ────────────────────────────────────────────────────────
router.get('/forgot-password', (req, res) => {
  res.render('forgot-password', {
    error: req.flash('error'),
    success: req.flash('success'),
    user: req.session.user || null
  });
});

router.post('/forgot-password', authLimiter, async (req, res) => {
  const { email } = req.body;
  const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
  // Always show success to prevent email enumeration
  if (!user || !user.password) {
    req.flash('success', 'If that email exists, a reset link has been sent.');
    return res.redirect('/forgot-password');
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  await db.run('DELETE FROM password_resets WHERE user_id = ?', [user.id]);
  await db.run(
    'INSERT INTO password_resets (user_id, token, expires_at) VALUES (?, ?, ?)',
    [user.id, token, expires.toISOString()]
  );

  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  const resetUrl = `${baseUrl}/reset-password/${token}`;

  if (!process.env.RESEND_API_KEY) {
    console.error('[ForgotPassword] RESEND_API_KEY is not set');
    req.flash('error', 'Email service is not configured. Please contact support.');
    return res.redirect('/forgot-password');
  }

  try {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: 'smtp.resend.com', port: 465, secure: true,
      auth: { user: 'resend', pass: process.env.RESEND_API_KEY }
    });
    await transporter.sendMail({
      from: 'Hathekhori <onboarding@resend.dev>',
      to: user.email,
      subject: 'Reset your Hathekhori password',
      text: `Hi ${user.name},\n\nClick the link below to reset your password. It expires in 1 hour.\n\n${resetUrl}\n\nIf you didn't request this, you can ignore this email.\n\n– Hathekhori`,
      html: `<p>Hi ${user.name},</p><p>Click the button below to reset your password. The link expires in <strong>1 hour</strong>.</p><p><a href="${resetUrl}" style="display:inline-block;padding:12px 28px;background:#898AC4;color:#fff;border-radius:6px;text-decoration:none;font-family:Inter,sans-serif;font-weight:600;">Reset Password</a></p><p style="font-size:0.82rem;color:#888;">Or copy this link: ${resetUrl}</p><p style="font-size:0.82rem;color:#aaa;">If you didn't request this, ignore this email.</p>`
    });
  } catch (err) {
    console.error('[ForgotPassword] Email error:', err.message);
    req.flash('error', 'Failed to send reset email. Please try again later.');
    return res.redirect('/forgot-password');
  }

  req.flash('success', 'If that email exists, a reset link has been sent.');
  res.redirect('/forgot-password');
});

// ── Reset Password ─────────────────────────────────────────────────────────
router.get('/reset-password/:token', async (req, res) => {
  const row = await db.get(
    'SELECT * FROM password_resets WHERE token = ? AND used = 0',
    [req.params.token]
  );
  if (!row || new Date(row.expires_at) < new Date()) {
    req.flash('error', 'This reset link is invalid or has expired.');
    return res.redirect('/forgot-password');
  }
  res.render('reset-password', {
    token: req.params.token,
    error: req.flash('error'),
    user: req.session.user || null
  });
});

router.post('/reset-password/:token', authLimiter, async (req, res) => {
  const { password, confirm_password } = req.body;
  const row = await db.get(
    'SELECT * FROM password_resets WHERE token = ? AND used = 0',
    [req.params.token]
  );
  if (!row || new Date(row.expires_at) < new Date()) {
    req.flash('error', 'This reset link is invalid or has expired.');
    return res.redirect('/forgot-password');
  }
  if (!password || password.length < 6) {
    req.flash('error', 'Password must be at least 6 characters.');
    return res.redirect(`/reset-password/${req.params.token}`);
  }
  if (password !== confirm_password) {
    req.flash('error', 'Passwords do not match.');
    return res.redirect(`/reset-password/${req.params.token}`);
  }
  const hash = await bcrypt.hash(password, 10);
  await db.run('UPDATE users SET password = ? WHERE id = ?', [hash, row.user_id]);
  await db.run('UPDATE password_resets SET used = 1 WHERE id = ?', [row.id]);
  req.flash('success', 'Password updated! Please log in.');
  res.redirect('/login');
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
