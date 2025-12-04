require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/orders', async (req, res) => {
  const { userName, room, note, items } = req.body;
  if (!userName || !room || !items || !items.length) {
    return res.status(400).json({ error: 'Eksik alanlar var' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderResult = await client.query(
      'INSERT INTO orders (user_name, room, note, status) VALUES ($1, $2, $3, $4) RETURNING id',
      [userName, room, note || '', 'active'],
    );
    const orderId = orderResult.rows[0].id;

    const values = [];
    const params = [];
    let paramIndex = 1;
    for (const item of items) {
      values.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
      params.push(orderId, item.product, item.quantity || 1);
    }

    await client.query(
      `INSERT INTO order_items (order_id, product_name, quantity) VALUES ${values.join(',')}`,
      params,
    );

    await client.query('COMMIT');
    res.status(201).json({ id: orderId });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(error);
    res.status(500).json({ error: 'Sunucu hatası' });
  } finally {
    client.release();
  }
});

app.get('/orders/user', async (req, res) => {
  const { userName } = req.query;
  if (!userName) {
    return res.status(400).json({ error: 'userName zorunlu' });
  }

  try {
    const result = await pool.query(
      `SELECT o.id, o.room, o.note, o.status, o.created_at,
              json_agg(json_build_object('product', i.product_name, 'quantity', i.quantity)) AS items
       FROM orders o
       JOIN order_items i ON i.order_id = o.id
       WHERE o.user_name = $1
       GROUP BY o.id
       ORDER BY o.created_at DESC`,
      [userName],
    );
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

app.get('/orders/admin/active', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.id, o.user_name, o.room, o.note, o.status, o.created_at,
              json_agg(json_build_object('product', i.product_name, 'quantity', i.quantity)) AS items
       FROM orders o
       JOIN order_items i ON i.order_id = o.id
       WHERE o.status = 'active'
       GROUP BY o.id
       ORDER BY o.created_at ASC`,
    );
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

app.get('/orders/admin/history', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.id, o.user_name, o.room, o.note, o.status, o.created_at, o.completed_at,
              json_agg(json_build_object('product', i.product_name, 'quantity', i.quantity)) AS items
       FROM orders o
       JOIN order_items i ON i.order_id = o.id
       WHERE o.status = 'completed'
       GROUP BY o.id
       ORDER BY o.completed_at DESC NULLS LAST`,
    );
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

app.post('/orders/:id/complete', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query(
      `UPDATE orders SET status = 'completed', completed_at = NOW() WHERE id = $1`,
      [id],
    );
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
