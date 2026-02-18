import { Router } from 'express';
import pool from '../db/connection';
import { authenticate, requireAdmin } from '../middleware/auth';

const router = Router();

router.get('/', authenticate, requireAdmin, async (_req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT m.*, u.email as user_email FROM memberships m
       LEFT JOIN users u ON m.user_id = u.id ORDER BY m.created_at DESC`
    );
    res.json(rows);
  } catch (error) {
    console.error('Get memberships error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.get('/my', authenticate, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM memberships WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
      [req.user!.id]
    );
    const memberships = rows as any[];
    res.json(memberships.length > 0 ? memberships[0] : null);
  } catch (error) {
    console.error('Get my membership error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// All memberships for payment history
router.get('/my/all', authenticate, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM memberships WHERE user_id = ? ORDER BY created_at DESC',
      [req.user!.id]
    );
    res.json(rows);
  } catch (error) {
    console.error('Get my memberships error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.post('/', authenticate, async (req, res) => {
  try {
    const { first_name, last_name, email, membership_type, amount, share_profile } = req.body;
    const id = require('uuid').v4();
    await pool.query(
      "INSERT INTO memberships (id, user_id, email, first_name, last_name, membership_type, amount, status, share_profile) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
      [id, req.user!.id, email, first_name, last_name, membership_type || 'standard', amount || 0, share_profile ?? false]
    );
    const [rows] = await pool.query('SELECT * FROM memberships WHERE id = ?', [id]);
    res.status(201).json((rows as any[])[0]);
  } catch (error) {
    console.error('Create membership error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.put('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    await pool.query('UPDATE memberships SET status = ?, updated_at = NOW() WHERE id = ?', [status, req.params.id]);
    const [rows] = await pool.query('SELECT * FROM memberships WHERE id = ?', [req.params.id]);
    res.json((rows as any[])[0]);
  } catch (error) {
    console.error('Update membership error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /memberships/:id/share-profile — user toggles their own share_profile
router.put('/:id/share-profile', authenticate, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM memberships WHERE id = ? AND user_id = ?', [req.params.id, req.user!.id]);
    const memberships = rows as any[];
    if (memberships.length === 0) {
      return res.status(404).json({ error: 'Adhésion non trouvée' });
    }
    const { share_profile } = req.body;
    await pool.query('UPDATE memberships SET share_profile = ?, updated_at = NOW() WHERE id = ?', [share_profile ? 1 : 0, req.params.id]);
    const [updated] = await pool.query('SELECT * FROM memberships WHERE id = ?', [req.params.id]);
    res.json((updated as any[])[0]);
  } catch (error) {
    console.error('Update share_profile error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /memberships/:id/cancel — user cancels their own membership
router.put('/:id/cancel', authenticate, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM memberships WHERE id = ? AND user_id = ?', [req.params.id, req.user!.id]);
    const memberships = rows as any[];
    if (memberships.length === 0) {
      return res.status(404).json({ error: 'Adhésion non trouvée' });
    }
    if (memberships[0].status === 'cancelled') {
      return res.status(400).json({ error: 'Adhésion déjà résiliée' });
    }
    await pool.query('UPDATE memberships SET status = ?, updated_at = NOW() WHERE id = ?', ['cancelled', req.params.id]);
    const [updated] = await pool.query('SELECT * FROM memberships WHERE id = ?', [req.params.id]);
    res.json((updated as any[])[0]);
  } catch (error) {
    console.error('Cancel membership error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /memberships/:id/reactivate — user reactivates their cancelled membership
// Only free if end_date is still in the future (already paid for this period)
router.put('/:id/reactivate', authenticate, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM memberships WHERE id = ? AND user_id = ?', [req.params.id, req.user!.id]);
    const memberships = rows as any[];
    if (memberships.length === 0) {
      return res.status(404).json({ error: 'Adhésion non trouvée' });
    }
    if (memberships[0].status !== 'cancelled') {
      return res.status(400).json({ error: 'L\'adhésion n\'est pas résiliée' });
    }

    const endDate = memberships[0].end_date ? new Date(memberships[0].end_date) : null;
    const now = new Date();

    if (!endDate || endDate <= now) {
      // Membership period has expired — require new payment
      return res.status(402).json({ error: 'Votre période d\'adhésion est expirée. Veuillez renouveler votre adhésion.', expired: true });
    }

    // end_date is in the future — reactivate for free (they already paid)
    await pool.query(
      'UPDATE memberships SET status = ?, updated_at = NOW() WHERE id = ?',
      ['active', req.params.id]
    );
    const [updated] = await pool.query('SELECT * FROM memberships WHERE id = ?', [req.params.id]);
    res.json((updated as any[])[0]);
  } catch (error) {
    console.error('Reactivate membership error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

export default router;
