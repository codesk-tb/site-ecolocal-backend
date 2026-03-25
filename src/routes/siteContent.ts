import { Router } from 'express';
import pool from '../db/connection';
import { authenticate, requireAdmin } from '../middleware/auth';

const router = Router();

async function ensureHomeHeroScrollAlignKey() {
  try {
    await pool.query(
      `INSERT INTO site_content (id, page_key, content_key, content_value, content_type, label, section, display_order, description)
       SELECT UUID(), 'home', 'hero_scroll_title_align', 'center', 'text', 'Alignement titre animation (H2)', 'hero', 7,
              'Position du titre H2 sur l''image de transition: centre-gauche, centre, centre-droite'
       WHERE NOT EXISTS (
         SELECT 1 FROM site_content WHERE page_key = 'home' AND content_key = 'hero_scroll_title_align'
       )`
    );
  } catch (err: any) {
    // Older schemas may not yet contain metadata columns (label/section/display_order/...)
    if (err?.code === 'ER_BAD_FIELD_ERROR') {
      await pool.query(
        `INSERT INTO site_content (id, page_key, content_key, content_value)
         SELECT UUID(), 'home', 'hero_scroll_title_align', 'center'
         WHERE NOT EXISTS (
           SELECT 1 FROM site_content WHERE page_key = 'home' AND content_key = 'hero_scroll_title_align'
         )`
      );
      return;
    }
    throw err;
  }
}

// GET /api/site-content?page_key=about
router.get('/', async (req, res) => {
  try {
    await ensureHomeHeroScrollAlignKey();
    const { page_key } = req.query;
    let query = 'SELECT * FROM site_content';
    const params: any[] = [];
    if (page_key) {
      query += ' WHERE page_key = ?';
      params.push(page_key);
    }
    query += ' ORDER BY page_key, section, display_order, content_key';
    const [rows] = await pool.query(query, params);

    // Ensure all rows have a label fallback and include new columns
    const result = (rows as any[]).map(row => ({
      ...row,
      label: row.label || row.content_key.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
      content_type: row.content_type || 'text',
      display_order: row.display_order || 0,
      section: row.section || null,
      description: row.description || null,
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
