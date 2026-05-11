require('dotenv').config();
const bcrypt = require('bcrypt');
const { db, initDb } = require('./database');

async function seed() {
  await initDb();

  const hash = await bcrypt.hash('admin123', 10);
  await db.run(
    `INSERT INTO users (name, email, password, is_admin) VALUES (?, ?, ?, 1) ON CONFLICT (email) DO NOTHING`,
    ['Admin', 'admin@khori.com', hash]
  );

  const products = [
    { name: 'Hand-painted Clay Pot', description: 'Beautiful terracotta pot hand-painted with traditional motifs.', price: 450, stock: 12, category: 'pottery' },
    { name: 'Macramé Wall Hanging', description: 'Boho-style macramé wall hanging made with natural cotton rope.', price: 850, stock: 8, category: 'textile' },
    { name: 'Beaded Jute Basket', description: 'Eco-friendly jute basket with hand-stitched beads.', price: 650, stock: 15, category: 'basket' },
    { name: 'Brass Wind Chimes', description: 'Handcrafted brass wind chimes with soothing tones.', price: 380, stock: 20, category: 'decor' },
    { name: 'Hand-block Print Tote', description: 'Cotton tote bag with traditional block print design.', price: 290, stock: 25, category: 'textile' },
    { name: 'Carved Wooden Coasters (Set of 4)', description: 'Set of 4 mango wood coasters with floral carvings.', price: 520, stock: 10, category: 'woodwork' },
  ];

  for (const p of products) {
    await db.run(
      `INSERT INTO products (name, description, price, stock, category, image) VALUES (?, ?, ?, ?, ?, 'placeholder.jpg')`,
      [p.name, p.description, p.price, p.stock, p.category]
    );
  }

  console.log('Seed complete!');
  console.log('Admin: admin@khori.com / admin123');
  process.exit(0);
}

seed().catch(err => { console.error(err); process.exit(1); });
