import { Router } from 'express';
import pool from '../db/connection';
import { authenticate, requireAdmin } from '../middleware/auth';

const router = Router();

// GET /api/site-content?page_key=about
router.get('/', async (req, res) => {
  try {
    const { page_key } = req.query;
    let query = 'SELECT * FROM site_content';
    const params: any[] = [];
    if (page_key) {
      query += ' WHERE page_key = ?';
      params.push(page_key);
    }
    query += ' ORDER BY page_key, content_key';
    const [rows] = await pool.query(query, params);
    
    // Ensure all rows have a label fallback
    const result = (rows as any[]).map(row => ({
      ...row,
      label: row.label || row.content_key.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
      content_type: row.content_type || 'text',
    }));
    
    res.json(result);
  } catch (error) {
    console.error('Get site content error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/site-content — upsert
router.put('/', authenticate, requireAdmin, async (req, res) => {
  try {
    const { page_key, content_key, content_value } = req.body;

    const [existing] = await pool.query(
      'SELECT id FROM site_content WHERE page_key = ? AND content_key = ?',
      [page_key, content_key]
    );

    if (Array.isArray(existing) && existing.length > 0) {
      await pool.query(
        'UPDATE site_content SET content_value = ?, updated_at = NOW() WHERE page_key = ? AND content_key = ?',
        [content_value, page_key, content_key]
      );
    } else {
      const id = require('uuid').v4();
      await pool.query(
        'INSERT INTO site_content (id, page_key, content_key, content_value) VALUES (?, ?, ?, ?)',
        [id, page_key, content_key, content_value]
      );
    }

    res.json({ message: 'Contenu mis à jour' });
  } catch (error) {
    console.error('Update site content error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Batch update
router.put('/batch', authenticate, requireAdmin, async (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items)) return res.status(400).json({ error: 'Items requis' });

    for (const item of items) {
      const [existing] = await pool.query(
        'SELECT id FROM site_content WHERE page_key = ? AND content_key = ?',
        [item.page_key, item.content_key]
      );

      if (Array.isArray(existing) && existing.length > 0) {
        await pool.query(
          'UPDATE site_content SET content_value = ?, updated_at = NOW() WHERE page_key = ? AND content_key = ?',
          [item.content_value, item.page_key, item.content_key]
        );
      } else {
        const id = require('uuid').v4();
        await pool.query(
          'INSERT INTO site_content (id, page_key, content_key, content_value) VALUES (?, ?, ?, ?)',
          [id, item.page_key, item.content_key, item.content_value]
        );
      }
    }

    res.json({ message: 'Contenu mis à jour en batch' });
  } catch (error) {
    console.error('Batch update site content error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

export default router;
