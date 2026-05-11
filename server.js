require('dotenv').config();
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const path = require('path');
const { initDb } = require('./database');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 }
}));
app.use(flash());

app.use('/', require('./routes/auth'));
app.use('/', require('./routes/products'));
app.use('/', require('./routes/cart'));
app.use('/', require('./routes/orders'));
app.use('/admin', require('./routes/admin'));

const PORT = process.env.PORT || 3000;

initDb().then(() => {
  app.listen(PORT, () => console.log(`Khori running at http://localhost:${PORT}`));
}).catch(err => {
  console.error('Database init failed:', err);
  process.exit(1);
});
