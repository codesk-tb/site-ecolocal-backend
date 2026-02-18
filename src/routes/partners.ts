import { Router } from 'express';
import pool from '../db/connection';
import { authenticate, requireAdmin } from '../middleware/auth';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const { published } = req.query;
    let query = 'SELECT * FROM partners';
    if (published !== 'all') {
      query += ' WHERE published = true';
    }
    query += ' ORDER BY display_order ASC';
    const [rows] = await pool.query(query);
    res.json(rows);
  } catch (error) {
    console.error('Get partners error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.post('/', authenticate, requireAdmin, async (req, res) => {
  try {
    const { name, logo_url, website_url, display_order, published } = req.body;
    const id = require('uuid').v4();
    await pool.query(
      'INSERT INTO partners (id, name, logo_url, website_url, display_order, published) VALUES (?, ?, ?, ?, ?, ?)',
      [id, name, logo_url || null, website_url || null, display_order || 0, published ?? true]
    );
    const [rows] = await pool.query('SELECT * FROM partners WHERE id = ?', [id]);
    res.status(201).json((rows as any[])[0]);
  } catch (error) {
    console.error('Create partner error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.put('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const { name, logo_url, website_url, display_order, published } = req.body;
    await pool.query(
      'UPDATE partners SET name = ?, logo_url = ?, website_url = ?, display_order = ?, published = ? WHERE id = ?',
      [name, logo_url || null, website_url || null, display_order || 0, published ?? true, req.params.id]
    );
    const [rows] = await pool.query('SELECT * FROM partners WHERE id = ?', [req.params.id]);
    res.json((rows as any[])[0]);
  } catch (error) {
    console.error('Update partner error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.delete('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM partners WHERE id = ?', [req.params.id]);
    res.json({ message: 'Partenaire supprimé' });
  } catch (error) {
    console.error('Delete partner error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

export default router;
