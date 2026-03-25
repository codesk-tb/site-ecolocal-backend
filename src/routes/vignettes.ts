import { Router } from 'express';
import pool from '../db/connection';
import { authenticate, requireAdmin } from '../middleware/auth';

const router = Router();

// PUT /api/vignettes/reorder/:id — reorder vignettes (MUST be before /:id)
router.put('/reorder/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const { display_order } = req.body;
    await pool.query(
      'UPDATE vignettes SET display_order = ? WHERE id = ?',
      [display_order, req.params.id]
    );
    res.json({ message: 'Ordre mis à jour' });
  } catch (error) {
    console.error('Reorder vignettes error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/vignettes — list all vignettes (published only for public)
router.get('/', async (req, res) => {
  try {
    const { all } = req.query;
    let query = 'SELECT * FROM vignettes';
    if (all !== 'true') {
      query += ' WHERE published = true';
    }
    query += ' ORDER BY display_order ASC';
    const [rows] = await pool.query(query);
    res.json(rows);
  } catch (error) {
    console.error('Get vignettes error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/vignettes — create vignette
router.post('/', authenticate, requireAdmin, async (req, res) => {
  try {
    console.log('📝 POST /vignettes - Creating vignette with body:', req.body);
    const { image_url, display_order, published } = req.body;
    const id = require('uuid').v4();
    console.log(`📝 Generated ID: ${id}, image_url: ${image_url}, display_order: ${display_order}, published: ${published}`);
    
    await pool.query(
      'INSERT INTO vignettes (id, image_url, display_order, published) VALUES (?, ?, ?, ?)',
      [id, image_url || '', display_order || 0, published ?? true]
    );
    console.log('✅ INSERT successful');
    
    const [rows] = await pool.query('SELECT * FROM vignettes WHERE id = ?', [id]);
    console.log('✅ SELECT successful:', rows);
    res.status(201).json((rows as any[])[0]);
  } catch (error) {
    console.error('❌ Create vignette error:', error instanceof Error ? error.message : error);
    console.error('❌ Full error:', error);
    res.status(500).json({ error: 'Erreur serveur', details: error instanceof Error ? error.message : String(error) });
  }
});

// PUT /api/vignettes/:id — update vignette
router.put('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const { image_url, display_order, published } = req.body;
    await pool.query(
      'UPDATE vignettes SET image_url = ?, display_order = ?, published = ? WHERE id = ?',
      [image_url || null, display_order || 0, published ?? true, req.params.id]
    );
    const [rows] = await pool.query('SELECT * FROM vignettes WHERE id = ?', [req.params.id]);
    res.json((rows as any[])[0]);
  } catch (error) {
    console.error('Update vignette error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /api/vignettes/:id — delete vignette
router.delete('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM vignettes WHERE id = ?', [req.params.id]);
    res.json({ message: 'Vignette supprimée' });
  } catch (error) {
    console.error('Delete vignette error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

export default router;
