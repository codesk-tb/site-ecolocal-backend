import { Router } from 'express';
import pool from '../db/connection';
import { authenticate, requireAdmin } from '../middleware/auth';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const { published } = req.query;
    let query = 'SELECT * FROM testimonials';
    if (published !== 'all') {
      query += ' WHERE published = true';
    }
    query += ' ORDER BY display_order ASC';
    const [rows] = await pool.query(query);
    res.json(rows);
  } catch (error) {
    console.error('Get testimonials error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.post('/', authenticate, requireAdmin, async (req, res) => {
  try {
    const { name, role, content, image_url, display_order, published } = req.body;
    const id = require('uuid').v4();
    await pool.query(
      'INSERT INTO testimonials (id, name, role, content, image_url, display_order, published) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, name, role || null, content, image_url || null, display_order || 0, published ?? true]
    );
    const [rows] = await pool.query('SELECT * FROM testimonials WHERE id = ?', [id]);
    res.status(201).json((rows as any[])[0]);
  } catch (error) {
    console.error('Create testimonial error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.put('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const { name, role, content, image_url, display_order, published } = req.body;
    await pool.query(
      'UPDATE testimonials SET name = ?, role = ?, content = ?, image_url = ?, display_order = ?, published = ? WHERE id = ?',
      [name, role || null, content, image_url || null, display_order || 0, published ?? true, req.params.id]
    );
    const [rows] = await pool.query('SELECT * FROM testimonials WHERE id = ?', [req.params.id]);
    res.json((rows as any[])[0]);
  } catch (error) {
    console.error('Update testimonial error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.delete('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM testimonials WHERE id = ?', [req.params.id]);
    res.json({ message: 'Témoignage supprimé' });
  } catch (error) {
    console.error('Delete testimonial error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

export default router;
