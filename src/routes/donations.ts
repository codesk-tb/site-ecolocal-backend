import { Router } from 'express';
import pool from '../db/connection';
import { authenticate, requireAdmin } from '../middleware/auth';

const router = Router();

router.get('/', authenticate, requireAdmin, async (_req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT d.*, u.email as user_email, u.full_name FROM donations d
       LEFT JOIN users u ON d.user_id = u.id ORDER BY d.created_at DESC`
    );
    res.json(rows);
  } catch (error) {
    console.error('Get donations error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.get('/my', authenticate, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM donations WHERE user_id = ? ORDER BY created_at DESC',
      [req.user!.id]
    );
    res.json(rows);
  } catch (error) {
    console.error('Get my donations error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.post('/', authenticate, async (req, res) => {
  try {
    const { amount, currency, is_recurring } = req.body;
    const id = require('uuid').v4();
    await pool.query(
      "INSERT INTO donations (id, amount, currency, status, user_id, is_recurring) VALUES (?, ?, ?, 'pending', ?, ?)",
      [id, amount, currency || 'EUR', req.user!.id, is_recurring ?? false]
    );
    const [rows] = await pool.query('SELECT * FROM donations WHERE id = ?', [id]);
    res.status(201).json((rows as any[])[0]);
  } catch (error) {
    console.error('Create donation error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

export default router;
