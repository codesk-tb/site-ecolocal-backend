import { Router } from 'express';
import pool from '../db/connection';
import { authenticate, requireAdmin } from '../middleware/auth';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    // Get admin-managed team members
    const [teamRows] = await pool.query('SELECT * FROM team_members ORDER BY display_order ASC');

    // Get members who opted to share their profile (active memberships with share_profile = 1)
    const [memberRows] = await pool.query(
      `SELECT m.id, CONCAT(m.first_name, ' ', m.last_name) as name, 'Membre adhérent' as role,
              NULL as bio, u.avatar_url as image_url, m.email, 999 as display_order
       FROM memberships m
       LEFT JOIN users u ON m.user_id = u.id
       WHERE m.share_profile = 1 AND m.status = 'active'
       ORDER BY m.created_at ASC`
    );

    // Combine: team members first, then shared-profile members
    const all = [...(teamRows as any[]), ...(memberRows as any[])];
    res.json(all);
  } catch (error) {
    console.error('Get team error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.post('/', authenticate, requireAdmin, async (req, res) => {
  try {
    const { name, role, bio, image_url, email, display_order } = req.body;
    const id = require('uuid').v4();
    await pool.query(
      'INSERT INTO team_members (id, name, role, bio, image_url, email, display_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, name, role || null, bio || null, image_url || null, email || null, display_order || 0]
    );
    const [rows] = await pool.query('SELECT * FROM team_members WHERE id = ?', [id]);
    res.status(201).json((rows as any[])[0]);
  } catch (error) {
    console.error('Create team member error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.put('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const { name, role, bio, image_url, email, display_order } = req.body;
    await pool.query(
      'UPDATE team_members SET name = ?, role = ?, bio = ?, image_url = ?, email = ?, display_order = ?, updated_at = NOW() WHERE id = ?',
      [name, role || null, bio || null, image_url || null, email || null, display_order || 0, req.params.id]
    );
    const [rows] = await pool.query('SELECT * FROM team_members WHERE id = ?', [req.params.id]);
    res.json((rows as any[])[0]);
  } catch (error) {
    console.error('Update team member error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.delete('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM team_members WHERE id = ?', [req.params.id]);
    res.json({ message: 'Membre supprimé' });
  } catch (error) {
    console.error('Delete team member error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

export default router;
