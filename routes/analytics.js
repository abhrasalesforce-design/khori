// Google Analytics 4 e-commerce helpers.
// Events that happen on a form POST (add to cart, purchase) are queued in the
// session and emitted by the header on the next page the visitor sees.
// Events tied to a page (view_item, view_cart, begin_checkout) are passed to
// the view as `gaPageEvents`. All are sent with gtag in views/partials/header.ejs.

const CURRENCY = 'INR';

function gaItem(p, quantity = 1, price) {
  return {
    item_id: String(p.id ?? p.product_id),
    item_name: p.name ?? p.product_name ?? '',
    item_category: p.category || undefined,
    price: Number(price ?? p.discountedPrice ?? p.price) || 0,
    quantity: Number(quantity) || 1,
  };
}

function itemsValue(items) {
  return items.reduce((s, i) => s + i.price * i.quantity, 0);
}

function ecommerce(items, extra = {}) {
  return { currency: CURRENCY, value: itemsValue(items), items, ...extra };
}

// Queue an event to be sent on the next rendered page.
function queueGaEvent(req, name, params) {
  if (!req.session) return;
  (req.session.gaEvents ||= []).push({ name, params });
  if (req.session.gaEvents.length > 20) req.session.gaEvents.splice(0, req.session.gaEvents.length - 20);
}

// Middleware: lets the header take (and clear) queued events while rendering,
// so JSON/AJAX requests never swallow them.
function gaMiddleware(req, res, next) {
  res.locals.takeGaEvents = () => {
    const ev = (req.session && req.session.gaEvents) || [];
    if (ev.length) req.session.gaEvents = [];
    return ev;
  };
  next();
}

module.exports = { CURRENCY, gaItem, ecommerce, queueGaEvent, gaMiddleware };
