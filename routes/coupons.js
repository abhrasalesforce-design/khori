// Coupon codes and cart pricing shared by the cart page, checkout page and the
// Razorpay charge, so every step computes exactly the same total.
const { db } = require('../database');
const { resolveCartItems } = require('./cartPricing');

const SHIPPING_FEE = 50;
const FREE_SHIPPING_FROM = 699;   // product subtotal (before coupon) for free shipping

const COUPONS = {
  HATHEKHORI10: {
    pct: 10,              // % off the products
    maxOff: 50,           // capped at ₹50
    requiresLogin: true,  // welcome offer for registered customers…
    firstOrderOnly: true, // …on their first order
    description: '10% off, up to ₹50',
  },
};

const normalize = code => String(code || '').trim().toUpperCase().replace(/\s+/g, '');

// Returns { ok: true, code, coupon } or { ok: false, error, login? }
async function checkCoupon(rawCode, req) {
  const code = normalize(rawCode);
  if (!code) return { ok: false, error: 'Please enter a coupon code.' };
  const coupon = COUPONS[code];
  if (!coupon) return { ok: false, error: `"${code}" isn't a valid coupon code.` };
  const user = req.session.user;
  if (coupon.requiresLogin && !user) {
    return { ok: false, login: true, error: `Please log in or create an account to use ${code}.` };
  }
  if (coupon.firstOrderOnly && user) {
    const prior = await db.get(
      'SELECT id FROM orders WHERE user_id = ? OR LOWER(email) = LOWER(?) LIMIT 1',
      [user.id, user.email || '']
    );
    if (prior) return { ok: false, error: `${code} is only valid on your first order.` };
  }
  return { ok: true, code, coupon };
}

function couponDiscount(coupon, subtotal) {
  return Math.min(Math.round((subtotal * coupon.pct) / 100), coupon.maxOff, subtotal);
}

// Prices the session cart, applying (and re-validating) any coupon in the session.
async function priceCart(req) {
  const items = await resolveCartItems(req.session.cart || []);
  const subtotal = items.reduce((s, i) => s + i.subtotal, 0);
  let discount = 0, couponCode = null, couponNotice = null;

  if (req.session.coupon && items.length) {
    const check = await checkCoupon(req.session.coupon, req);
    if (check.ok) {
      couponCode = check.code;
      discount = couponDiscount(check.coupon, subtotal);
    } else {
      couponNotice = check.error + ' The coupon was removed.';
      req.session.coupon = null;
    }
  }
  const shipping = items.length && subtotal < FREE_SHIPPING_FROM ? SHIPPING_FEE : 0;
  const total = Math.max(0, subtotal - discount + shipping);
  return { items, subtotal, discount, couponCode, couponNotice, shipping, total,
           couponDescription: couponCode ? COUPONS[couponCode].description : null };
}

// One-time coupon messages for the cart/checkout views
function couponFlash(req, pricing) {
  const err = req.flash('couponError')[0] || pricing.couponNotice || null;
  return { couponError: err, couponSuccess: req.flash('couponSuccess')[0] || null, couponLogin: !!req.flash('couponLogin')[0] };
}

module.exports = { couponFlash, COUPONS, checkCoupon, couponDiscount, priceCart, normalize, SHIPPING_FEE, FREE_SHIPPING_FROM };
