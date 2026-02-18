import { Router } from 'express';
import pool from '../db/connection';
import { authenticate, requireAdmin } from '../middleware/auth';

const router = Router();

// GET /api/site-settings
router.get('/', async (req, res) => {
  try {
    const { category } = req.query;
    let query = 'SELECT * FROM site_settings';
    const params: any[] = [];
    if (category) {
      query += ' WHERE category = ?';
      params.push(category);
    }
    const [rows] = await pool.query(query, params);

    // Transform to key-value object
    const settings: Record<string, string> = {};
    (rows as any[]).forEach(row => {
      settings[row.setting_key] = row.setting_value;
    });

    res.json(settings);
  } catch (error) {
    console.error('Get site settings error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/site-settings/raw — returns raw rows for admin
router.get('/raw', authenticate, requireAdmin, async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM site_settings ORDER BY category, display_order, setting_key');
    
    // Ensure all rows have label fallback
    const result = (rows as any[]).map(row => ({
      ...row,
      label: row.label || row.setting_key.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
      setting_type: row.setting_type || 'text',
    }));
    
    res.json(result);
  } catch (error) {
    console.error('Get raw site settings error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/site-settings — upsert single
router.put('/', authenticate, requireAdmin, async (req, res) => {
  try {
    const { setting_key, setting_value, category } = req.body;

    const [existing] = await pool.query(
      'SELECT id FROM site_settings WHERE setting_key = ?',
      [setting_key]
    );

    if (Array.isArray(existing) && existing.length > 0) {
      await pool.query(
        'UPDATE site_settings SET setting_value = ?, updated_at = NOW() WHERE setting_key = ?',
        [setting_value, setting_key]
      );
    } else {
      const id = require('uuid').v4();
      await pool.query(
        'INSERT INTO site_settings (id, setting_key, setting_value, category) VALUES (?, ?, ?, ?)',
        [id, setting_key, setting_value, category || 'general']
      );
    }

    res.json({ message: 'Paramètre mis à jour' });
  } catch (error) {
    console.error('Update site setting error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/site-settings/batch — upsert multiple
router.put('/batch', authenticate, requireAdmin, async (req, res) => {
  try {
    const { settings } = req.body;
    if (!Array.isArray(settings)) return res.status(400).json({ error: 'Settings requis' });

    for (const item of settings) {
      const [existing] = await pool.query(
        'SELECT id FROM site_settings WHERE setting_key = ?',
        [item.setting_key]
      );

      if (Array.isArray(existing) && existing.length > 0) {
        await pool.query(
          'UPDATE site_settings SET setting_value = ?, updated_at = NOW() WHERE setting_key = ?',
          [item.setting_value, item.setting_key]
        );
      } else {
        const id = require('uuid').v4();
        await pool.query(
          'INSERT INTO site_settings (id, setting_key, setting_value, category) VALUES (?, ?, ?, ?)',
          [id, item.setting_key, item.setting_value, item.category || 'general']
        );
      }
    }

    res.json({ message: 'Paramètres mis à jour en batch' });
  } catch (error) {
    console.error('Batch update settings error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

export default router;
