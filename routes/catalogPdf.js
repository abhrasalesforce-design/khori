// Generates the Product Catalogue and Create Your Basket PDFs from live data.
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const sharp = require('sharp');
const { db } = require('../database');
const { getDiscountMap, applyDiscount } = require('./cartPricing');

const SITE = process.env.SITE_URL || 'https://www.hathekhori.com';
const ROOT = path.join(__dirname, '..');
const LOGO = path.join(ROOT, 'public/images/logo.png');
const NO_IMAGE = path.join(ROOT, 'public/images/no-image.jpg');

const fontFile = (pkg, name) => require.resolve(`@fontsource/${pkg}/files/${name}`);
const FONTS = {
  body: fontFile('inter', 'inter-latin-400-normal.woff'),
  semi: fontFile('inter', 'inter-latin-600-normal.woff'),
  bold: fontFile('inter', 'inter-latin-700-normal.woff'),
  rupee: fontFile('inter', 'inter-latin-ext-600-normal.woff'), // ₹ lives in the latin-ext subset
  serif: fontFile('playfair-display', 'playfair-display-latin-600-normal.woff'),
};

const C = { lav: '#898AC4', ink: '#3a3a5c', cream: '#F6F4E8', pink: '#F5AFAF', muted: '#8a8aa3', soft: '#5a5a78', line: '#e8e4f2' };
const A4 = { w: 595.28, h: 841.89 };
const M = 36;                       // page margin
const BOTTOM = A4.h - M - 18;       // leave room for footer

// ---------- helpers ----------
function clean(t) {
  return String(t || '')
    .replace(/[AÃ]\u0097/g, '×').replace(/\u0097/g, '×')   // fix mis-encoded "×" from Excel imports
    .replace(/\s+/g, ' ').trim();
}
const money = v => Math.round(v).toLocaleString('en-IN');
const today = () => new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });

function firstImage(p) {
  let imgs = [];
  try { imgs = p.images ? JSON.parse(p.images) : []; } catch (_) {}
  if (!imgs.length && p.image) imgs = [p.image];
  return imgs.find(i => i && i !== 'placeholder.jpg') || null;
}

async function loadImage(src, w, h) {
  try {
    let buf;
    if (!src) throw new Error('none');
    if (/^https?:\/\//.test(src)) {
      const url = src.includes('res.cloudinary.com') && src.includes('/image/upload/')
        ? src.replace('/image/upload/', `/image/upload/c_fill,w_${w * 2},h_${h * 2},g_auto,q_auto:good,f_jpg/`)
        : src;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const r = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) throw new Error('http ' + r.status);
      buf = Buffer.from(await r.arrayBuffer());
    } else {
      buf = await fs.promises.readFile(path.join(ROOT, 'public/uploads', path.basename(src)));
    }
    return await sharp(buf).resize(w * 2, h * 2, { fit: 'cover', position: 'attention' }).jpeg({ quality: 78 }).toBuffer();
  } catch (_) {
    return await sharp(NO_IMAGE).resize(w * 2, h * 2, { fit: 'cover' }).jpeg({ quality: 78 }).toBuffer();
  }
}

// Fetch images a few at a time so we don't hammer Cloudinary or the server.
async function loadImages(products, w, h) {
  const out = new Map();
  let i = 0;
  const worker = async () => {
    while (i < products.length) {
      const p = products[i++];
      out.set(p.id, await loadImage(firstImage(p), w, h));
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return out;
}

function newDoc(title) {
  const doc = new PDFDocument({ size: 'A4', margin: M, bufferPages: true, info: { Title: title, Author: 'Hathekhori' } });
  for (const [k, f] of Object.entries(FONTS)) doc.registerFont(k, f);
  return doc;
}

function footer(doc, label) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0;   // writing inside the bottom margin must not spill onto a new page
    const y = A4.h - M + 6;
    doc.font('body').fontSize(7).fillColor(C.muted);
    doc.text(`Hathekhori · ${label}`, M, y, { lineBreak: false });
    doc.text('www.hathekhori.com', 0, y, { width: A4.w, align: 'center', lineBreak: false });
    doc.text(`${i + 1} / ${range.count}`, A4.w - M - 60, y, { width: 60, align: 'right', lineBreak: false });
  }
}

// Draws "₹499" using the rupee glyph from one font and digits from another.
function price(doc, amount, x, y, size, color = C.ink) {
  doc.font('rupee').fontSize(size).fillColor(color).text('₹', x, y, { lineBreak: false });
  const rw = doc.widthOfString('₹');
  doc.font('bold').fontSize(size).text(money(amount), x + rw, y, { lineBreak: false });
  return rw + doc.widthOfString(money(amount));
}

function priceRow(doc, p, x, y, small) {
  let w = price(doc, p.salePrice, x, y, small ? 9.5 : 11);
  if (p.salePrice < p.price) {
    const ox = x + w + 5, oy = y + (small ? 1.5 : 2.5), fs = small ? 7 : 8;
    const ow = price(doc, p.price, ox, oy, fs, '#aaaaaa');
    doc.moveTo(ox, oy + fs * 0.55).lineTo(ox + ow, oy + fs * 0.55).lineWidth(0.6).strokeColor('#aaaaaa').stroke();
    if (!small) {
      const label = `${Math.round(100 - (p.salePrice * 100) / p.price)}% OFF`;
      doc.font('bold').fontSize(6.5);
      const bw = doc.widthOfString(label) + 8, bx = ox + ow + 5;
      doc.roundedRect(bx, y + 1.5, bw, 10, 2).fill(C.pink);
      doc.fillColor('#fff').text(label, bx + 4, y + 3.6, { lineBreak: false });
    }
  }
}

function card(doc, p, img, x, y, w, imgH, opts) {
  const { desc, small } = opts;
  const h = cardHeight(imgH, opts);
  doc.roundedRect(x, y, w, h, 6).lineWidth(0.7).strokeColor(C.line).stroke();
  doc.save().roundedRect(x, y, w, h, 6).clip();
  if (p.soldOut) doc.opacity(0.5);
  doc.image(img, x, y, { width: w, height: imgH });
  doc.opacity(1).restore();
  if (p.soldOut) {
    doc.font('bold').fontSize(6.5);
    const bw = doc.widthOfString('SOLD OUT') + 10;
    doc.roundedRect(x + 6, y + 6, bw, 12, 2).fill(C.ink);
    doc.fillColor('#fff').text('SOLD OUT', x + 11, y + 9, { lineBreak: false });
  }
  const pad = small ? 6 : 8, tx = x + pad, tw = w - pad * 2;
  let ty = y + imgH + pad;
  doc.font('body').fontSize(6.5).fillColor(C.muted).text(`HK-${String(p.id).padStart(3, '0')}`, tx, ty, { characterSpacing: 0.6, lineBreak: false });
  ty += 10;
  const nameSize = small ? 7.8 : 8.8, nameH = nameSize * 1.3 * 2;
  doc.font('semi').fontSize(nameSize).fillColor(C.ink)
    .text(clean(p.name), tx, ty, { width: tw, height: nameH, ellipsis: true, lineGap: 1, link: `${SITE}/product/${p.id}` });
  ty += nameH + 3;
  priceRow(doc, p, tx, ty, small);
  ty += small ? 14 : 16;
  const dim = clean(p.dimension);
  const mat = clean(p.material);
  const meta = [dim && (/inch/i.test(dim) ? dim : dim + ' in'), mat && mat.length <= 40 ? mat : null].filter(Boolean).join(' · ');
  if (meta) doc.font('body').fontSize(7.2).fillColor(C.soft).text(meta, tx, ty, { width: tw, height: 9, ellipsis: true, lineBreak: false });
  ty += 11;
  if (desc && p.description) {
    doc.font('body').fontSize(7.2).fillColor('#6b6b85').text(clean(p.description), tx, ty, { width: tw, height: 19, ellipsis: true, lineGap: 0.5 });
  }
}
function cardHeight(imgH, { desc, small }) {
  return imgH + (small ? 6 : 8) * 2 + 10 + (small ? 7.8 : 8.8) * 2.6 + 3 + (small ? 14 : 16) + 11 + (desc ? 21 : 0);
}

function grid(doc, items, images, cols, y, opts) {
  const gap = cols > 3 ? 9 : 12;
  const w = (A4.w - M * 2 - gap * (cols - 1)) / cols;
  const imgH = opts.square ? w : Math.round(w * 0.75);
  const h = cardHeight(imgH, opts);
  for (let i = 0; i < items.length; i += cols) {
    if (y + h > BOTTOM) { doc.addPage(); y = M; }
    items.slice(i, i + cols).forEach((p, j) => card(doc, p, images.get(p.id), M + j * (w + gap), y, w, imgH, opts));
    y += h + gap;
  }
  return y;
}

function ensure(doc, y, need) {
  if (y + need > BOTTOM) { doc.addPage(); return M; }
  return y;
}

function sectionHead(doc, y, eyebrow, title, blurb) {
  doc.rect(M, y, 5, blurb ? 50 : 38).fill(C.lav);
  doc.font('bold').fontSize(7).fillColor(C.lav).text(eyebrow.toUpperCase(), M + 14, y + 2, { characterSpacing: 2, lineBreak: false });
  doc.font('serif').fontSize(20).fillColor(C.ink).text(title, M + 14, y + 12, { lineBreak: false });
  if (blurb) doc.font('body').fontSize(9).fillColor(C.soft).text(blurb, M + 14, y + 38, { width: A4.w - M * 2 - 14, lineBreak: false });
  return y + (blurb ? 64 : 52);
}

function cover(doc, { eyebrow, title, lede, facts, foot }) {
  doc.roundedRect(M, M, A4.w - M * 2, A4.h - M * 2 - 10, 16).fill(C.cream);
  const lw = 300;
  doc.image(LOGO, (A4.w - lw) / 2, 170, { width: lw });
  let y = 170 + lw * 297 / 900 + 40;
  doc.font('bold').fontSize(8.5).fillColor(C.lav).text(eyebrow.toUpperCase(), M, y, { width: A4.w - M * 2, align: 'center', characterSpacing: 3 });
  y += 22;
  doc.font('serif').fontSize(30).fillColor(C.ink).text(title, M + 30, y, { width: A4.w - M * 2 - 60, align: 'center' });
  y = doc.y + 14;
  doc.font('body').fontSize(11).fillColor(C.soft).text(lede, M + 70, y, { width: A4.w - M * 2 - 140, align: 'center', lineGap: 2 });
  y = doc.y + 40;
  const fw = 140, fx = (A4.w - fw * facts.length) / 2;
  facts.forEach(([v, l], i) => {
    const cx = fx + i * fw;
    if (v.startsWith('₹')) {
      doc.font('serif').fontSize(20);
      const parts = v.split('₹').filter(Boolean);
      // centre a value like "₹99–₹499" made of rupee + serif pieces
      doc.font('rupee').fontSize(18); const rw = doc.widthOfString('₹');
      doc.font('serif').fontSize(20);
      const total = parts.reduce((s, t) => s + rw + doc.widthOfString(t), 0);
      let x = cx + (fw - total) / 2;
      parts.forEach(t => {
        doc.font('rupee').fontSize(18).fillColor(C.lav).text('₹', x, y + 2, { lineBreak: false }); x += rw;
        doc.font('serif').fontSize(20).fillColor(C.lav).text(t, x, y, { lineBreak: false }); x += doc.widthOfString(t);
      });
    } else {
      doc.font('serif').fontSize(20).fillColor(C.lav).text(v, cx, y, { width: fw, align: 'center', lineBreak: false });
    }
    doc.font('semi').fontSize(7.5).fillColor(C.muted).text(l.toUpperCase(), cx, y + 30, { width: fw, align: 'center', characterSpacing: 1.2, lineBreak: false });
  });
  doc.font('body').fontSize(8.5).fillColor(C.muted).text(foot, M, A4.h - M - 50, { width: A4.w - M * 2, align: 'center', lineBreak: false });
}

function note(doc, y, text) {
  doc.font('body').fontSize(8.2);
  const h = doc.heightOfString(text, { width: A4.w - M * 2 - 28 }) + 20;
  y = ensure(doc, y, h);
  doc.roundedRect(M, y, A4.w - M * 2, h, 6).fill(C.cream);
  doc.fillColor(C.soft).text(text, M + 14, y + 10, { width: A4.w - M * 2 - 28 });
  return y + h + 12;
}

async function priced(rows) {
  const map = await getDiscountMap();
  return rows.map(p => ({ ...p, salePrice: applyDiscount(p.price, p.category, map), soldOut: !(p.stock > 0) }));
}

// ---------- Catalogue ----------
async function buildCatalogue(stream) {
  const products = await priced(await db.all("SELECT * FROM products WHERE category != 'basket-addon' ORDER BY name"));
  const cats = await db.all('SELECT * FROM categories ORDER BY sort_order, id');
  const parents = cats.filter(c => !c.parent_id);
  const groups = parents.map(p => {
    const kids = cats.filter(c => c.parent_id === p.id);
    return { name: p.name, subs: (kids.length ? kids : [p]).map(k => ({ name: k.name, slug: k.slug })) };
  });
  const known = new Set(groups.flatMap(g => g.subs.map(s => s.slug)));
  const extra = [...new Set(products.map(p => p.category).filter(c => !known.has(c)))].sort();
  if (extra.length) groups.push({ name: 'Also Available', subs: extra.map(s => ({ name: s.replace(/-/g, ' ').replace(/\b\w/g, m => m.toUpperCase()), slug: s })) });

  const bySlug = {};
  for (const p of products.sort((a, b) => (a.soldOut - b.soldOut) || a.name.localeCompare(b.name))) (bySlug[p.category] ||= []).push(p);
  for (const g of groups) { g.subs = g.subs.filter(s => bySlug[s.slug]); g.count = g.subs.reduce((n, s) => n + bySlug[s.slug].length, 0); }
  const shown = groups.filter(g => g.count);

  const images = await loadImages(products, 240, 180);
  const doc = newDoc('Hathekhori Product Catalogue');
  doc.pipe(stream);

  const prices = products.map(p => p.salePrice);
  const date = today();
  cover(doc, {
    eyebrow: 'Product Catalogue', title: 'Handmade Crafts, Rooted in Bengal',
    lede: 'Every piece is made by hand by artisans across India: jewellery, totes, miniature paintings and hand block printed keepsakes.',
    facts: [[String(products.length), 'Products'], [String(shown.length), 'Collections'], [prices.length ? `₹${money(Math.min(...prices))}–₹${money(Math.max(...prices))}` : '–', 'Price range']],
    foot: `www.hathekhori.com · contact.hathekhori@gmail.com · Prices as of ${date}`,
  });

  // Contents
  doc.addPage();
  doc.font('serif').fontSize(20).fillColor(C.ink).text('Contents', M, M + 6);
  let y = M + 46;
  const row = (label, right, sub) => {
    doc.font(sub ? 'body' : 'serif').fontSize(sub ? 9 : 11).fillColor(sub ? C.soft : C.ink).text(label, M + (sub ? 16 : 0), y, { lineBreak: false });
    doc.font('body').fontSize(9).fillColor(C.muted).text(right, M, y + (sub ? 0 : 1), { width: A4.w - M * 2, align: 'right', lineBreak: false });
    y += sub ? 18 : 21;
    doc.moveTo(M, y - 5).lineTo(A4.w - M, y - 5).lineWidth(0.6).strokeColor(C.line).stroke();
  };
  for (const g of shown) { y = ensure(doc, y, 40); row(g.name, `${g.count} pieces`); g.subs.forEach(s => row(s.name, String(bySlug[s.slug].length), true)); }
  const sold = products.filter(p => p.soldOut).length;
  note(doc, y + 10, `Prices shown are current sale prices, inclusive of all taxes, as listed on www.hathekhori.com on ${date}. ` +
    `${sold} pieces are currently sold out and are marked as such. Free shipping on orders above Rs. 699; standard delivery in 5–7 business days. ` +
    'Tap any product name to open it on the website.');

  for (const g of shown) {
    doc.addPage();
    y = sectionHead(doc, M, 'Collection', g.name);
    for (const s of g.subs) {
      const items = bySlug[s.slug];
      y = ensure(doc, y, 230);
      doc.font('serif').fontSize(13).fillColor(C.ink).text(s.name, M, y, { lineBreak: false });
      const nw = doc.widthOfString(s.name);
      doc.font('body').fontSize(8).fillColor(C.muted).text(`${items.length} pieces`, M + nw + 8, y + 4, { lineBreak: false });
      y = grid(doc, items, images, 3, y + 24, { desc: true }) + 8;
    }
  }
  footer(doc, 'Product Catalogue');
  doc.end();
}

// ---------- Create Your Basket ----------
async function buildBaskets(stream) {
  const { BASKET_DEFS } = require('./baskets');
  const date = today();
  const combos = [];
  for (const [key, def] of Object.entries(BASKET_DEFS)) {
    const slots = [];
    for (const s of def.slots) {
      const ph = s.categories.map(() => '?').join(',');
      const items = await priced(await db.all(`SELECT * FROM products WHERE category IN (${ph}) AND stock > 0 ORDER BY name ASC`, s.categories));
      slots.push({ ...s, items });
    }
    let lo = 0, hi = 0;
    for (const s of slots) {
      const pr = s.items.map(p => p.salePrice).sort((a, b) => a - b);
      if (pr.length) { lo += pr.slice(0, s.min).reduce((a, b) => a + b, 0); hi += pr.slice(-s.max).reduce((a, b) => a + b, 0); }
    }
    combos.push({ key, ...def, slots, lo, hi });
  }
  const all = new Map();
  combos.forEach(c => c.slots.forEach(s => s.items.forEach(p => all.set(p.id, p))));
  const images = await loadImages([...all.values()], 180, 180);

  const doc = newDoc('Hathekhori Create Your Basket');
  doc.pipe(stream);
  cover(doc, {
    eyebrow: 'Handcrafted Gift Sets', title: 'Create Your Basket',
    lede: "Pick a combo, personalise it with your favourite pieces, and we'll wrap it all up beautifully. Add a gift basket to any combo for just Rs. 50.",
    facts: [[String(combos.length), 'Combos'], [String(all.size), 'Pieces to choose'], ['₹50', 'Gift basket add-on']],
    foot: `www.hathekhori.com/baskets · contact.hathekhori@gmail.com · Availability as of ${date}`,
  });

  const rangeText = c => c.lo === c.hi ? [c.lo] : [c.lo, c.hi];
  const drawRange = (doc, c, x, y, size, color) => {
    const r = rangeText(c);
    let w = price(doc, r[0], x, y, size, color);
    if (r[1] != null) {
      doc.font('bold').fontSize(size).fillColor(color).text(' – ', x + w, y, { lineBreak: false });
      w += doc.widthOfString(' – ');
      w += price(doc, r[1], x + w, y, size, color);
    }
    return w;
  };

  // Overview
  doc.addPage();
  let y = sectionHead(doc, M, 'How it works', 'Your gift, your way');
  const steps = ['Choose a combo below.', 'Pick your favourite piece for each slot from the options listed.', "Add the gift basket if you'd like it wrapped and ready to give."];
  const sw = (A4.w - M * 2 - 24) / 3;
  steps.forEach((t, i) => {
    const x = M + i * (sw + 12);
    doc.roundedRect(x, y, sw, 62, 6).fill(C.cream);
    doc.font('serif').fontSize(16).fillColor(C.lav).text(String(i + 1), x + 12, y + 8, { lineBreak: false });
    doc.font('body').fontSize(8.6).fillColor(C.ink).text(t, x + 12, y + 30, { width: sw - 24 });
  });
  y += 78;
  const cw = (A4.w - M * 2 - 14) / 2;
  for (let i = 0; i < combos.length; i += 2) {
    const pair = combos.slice(i, i + 2);
    const ch = 70 + Math.max(...pair.map(c => c.slots.length)) * 18 + 26;
    y = ensure(doc, y, ch);
    pair.forEach((c, j) => {
      const x = M + j * (cw + 14);
      doc.roundedRect(x, y, cw, ch, 8).lineWidth(0.7).strokeColor(C.line).stroke();
      doc.font('serif').fontSize(14).fillColor(C.ink).text(c.label, x + 14, y + 14, { lineBreak: false });
      doc.font('body').fontSize(8.4).fillColor(C.soft).text(c.tagline, x + 14, y + 36, { width: cw - 28, height: 24, ellipsis: true });
      let ly = y + 66;
      c.slots.forEach(s => {
        doc.font('body').fontSize(8.6).fillColor(C.ink).text(`${s.min === s.max ? s.min : `${s.min}–${s.max}`} × ${s.label}`, x + 14, ly, { lineBreak: false });
        doc.fillColor(C.muted).text(`${s.items.length} options`, x + 14, ly, { width: cw - 28, align: 'right', lineBreak: false });
        ly += 18;
        doc.moveTo(x + 14, ly - 5).lineTo(x + cw - 14, ly - 5).dash(2, { space: 2 }).lineWidth(0.5).strokeColor(C.line).stroke().undash();
      });
      const w = drawRange(doc, c, x + 14, ly + 2, 9.5, C.lav);
      doc.font('body').fontSize(8.4).fillColor(C.muted).text(' + Rs. 50 optional gift basket', x + 14 + w, ly + 3.5, { lineBreak: false });
    });
    y += ch + 14;
  }
  note(doc, y, `Combo price is the total of the pieces you choose, at current sale prices inclusive of taxes. Only pieces in stock on ${date} are listed. Free shipping on orders above Rs. 699.`);

  for (const c of combos) {
    doc.addPage();
    y = sectionHead(doc, M, 'Combo', c.label, c.tagline);
    drawRange(doc, c, A4.w - M - 120, M + 16, 12, C.lav);
    for (const s of c.slots) {
      y = ensure(doc, y, 200);
      doc.roundedRect(M, y, A4.w - M * 2, 26, 4).fill(C.cream);
      doc.font('serif').fontSize(11).fillColor(C.ink).text(`Choose ${s.min === s.max ? s.min : `${s.min} to ${s.max}`}: ${s.label}`, M + 12, y + 7, { lineBreak: false });
      doc.font('body').fontSize(8).fillColor(C.soft).text(`${s.items.length} options`, M, y + 9, { width: A4.w - M * 2 - 12, align: 'right', lineBreak: false });
      y += 36;
      if (!s.items.length) {
        doc.font('body').fontSize(9).fillColor(C.muted).text('No pieces in stock right now.', M, y);
        y += 24;
      } else {
        y = grid(doc, s.items, images, 4, y, { square: true, small: true }) + 4;
      }
    }
  }
  footer(doc, 'Create Your Basket');
  doc.end();
}

module.exports = { buildCatalogue, buildBaskets };
