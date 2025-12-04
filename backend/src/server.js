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
  const { userName, room, note, items, originalOrderId } = req.body;
  if (!userName || !room || !items || !items.length) {
    return res.status(400).json({ error: 'Eksik alanlar var' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const normalized = String(userName).trim();
    const role = normalized.toLocaleLowerCase('tr-TR') === 'elif kaya' ? 'admin' : 'user';

    const userResult = await client.query(
      `INSERT INTO users (full_name, role)
       VALUES ($1, $2)
       ON CONFLICT (full_name) DO UPDATE SET role = EXCLUDED.role
       RETURNING id`,
      [normalized, role],
    );
    const userId = userResult.rows[0].id;

    const orderResult = await client.query(
      'INSERT INTO orders (user_id, user_name, room, note, status, original_order_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [userId, normalized, room, note || '', 'active', originalOrderId || null],
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

app.put('/orders/:id', async (req, res) => {
  const { id } = req.params;
  const { room, note, items } = req.body;

  if (!room || !items || !items.length) {
    return res.status(400).json({ error: 'Eksik alanlar var' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query('SELECT status FROM orders WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Sipariş bulunamadı' });
    }
    if (existing.rows[0].status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Sadece aktif siparişler düzenlenebilir' });
    }

    await client.query('UPDATE orders SET room = $1, note = $2 WHERE id = $3', [room, note || '', id]);
    await client.query('DELETE FROM order_items WHERE order_id = $1', [id]);

    const values = [];
    const params = [];
    let paramIndex = 1;
    for (const item of items) {
      values.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
      params.push(id, item.product, item.quantity || 1);
    }

    await client.query(
      `INSERT INTO order_items (order_id, product_name, quantity) VALUES ${values.join(',')}`,
      params,
    );

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(error);
    res.status(500).json({ error: 'Sunucu hatası' });
  } finally {
    client.release();
  }
});

app.post('/orders/:id/duplicate', async (req, res) => {
  const { id } = req.params;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const orderResult = await client.query('SELECT * FROM orders WHERE id = $1', [id]);
    if (orderResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Sipariş bulunamadı' });
    }
    const order = orderResult.rows[0];

    const itemsResult = await client.query(
      'SELECT product_name, quantity FROM order_items WHERE order_id = $1',
      [id],
    );

    const newOrderResult = await client.query(
      'INSERT INTO orders (user_id, user_name, room, note, status, original_order_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [order.user_id, order.user_name, order.room, order.note || '', 'active', order.id],
    );
    const newOrderId = newOrderResult.rows[0].id;

    if (itemsResult.rows.length) {
      const values = [];
      const params = [];
      let paramIndex = 1;
      for (const item of itemsResult.rows) {
        values.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
        params.push(newOrderId, item.product_name, item.quantity || 1);
      }

      await client.query(
        `INSERT INTO order_items (order_id, product_name, quantity) VALUES ${values.join(',')}`,
        params,
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ id: newOrderId });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(error);
    res.status(500).json({ error: 'Sunucu hatası' });
  } finally {
    client.release();
  }
});

app.get('/orders/user', async (req, res) => {
  const { userName, status } = req.query;
  if (!userName) {
    return res.status(400).json({ error: 'userName zorunlu' });
  }

  const statusFilter =
    status && (status === 'active' || status === 'completed') ? String(status) : null;

  try {
    const params = [userName];
    let whereClause = 'WHERE u.full_name = $1';

    if (statusFilter) {
      params.push(statusFilter);
      whereClause += ` AND o.status = $${params.length}`;
    }

    const result = await pool.query(
      `SELECT o.id, o.room, o.note, o.status, o.created_at,
              json_agg(json_build_object('product', i.product_name, 'quantity', i.quantity)) AS items
       FROM orders o
       JOIN users u ON u.id = o.user_id
       JOIN order_items i ON i.order_id = o.id
       ${whereClause}
       GROUP BY o.id
       ORDER BY o.created_at DESC`,
      params,
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
