import { Router } from 'express';
import pool from '../db/connection';
import { authenticate, requireAdmin } from '../middleware/auth';
import { encrypt, decrypt, isSecretKey } from '../utils/crypto';

const router = Router();

// Keys that contain secrets and must NEVER be exposed publicly
const SECRET_KEYS = new Set([
  'stripe_secret_key',
  'stripe_webhook_secret',
  'email_smtp_pass',
  'fb_page_access_token',
  'ig_business_account_id',
]);

// Categories that are entirely private (admin-only)
const PRIVATE_CATEGORIES = new Set(['emails', 'automation']);

// Keys from private categories that are safe to expose publicly
const PUBLIC_ALLOWED_KEYS = new Set([
  'newsletter_enabled',
  'email_from_name',
]);

// GET /api/site-settings — public, secrets are filtered out
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

    // Transform to key-value object, filtering out secrets
    const settings: Record<string, string> = {};
    (rows as any[]).forEach(row => {
      // Skip secret keys
      if (SECRET_KEYS.has(row.setting_key)) return;
      if (row.setting_type === 'secret') return;
      // For private categories, only allow explicitly whitelisted keys
      if (PRIVATE_CATEGORIES.has(row.category) && !PUBLIC_ALLOWED_KEYS.has(row.setting_key)) return;
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
    
    // Ensure all rows have label fallback, decrypt secrets for admin view
    const result = (rows as any[]).map(row => ({
      ...row,
      setting_value: isSecretKey(row.setting_key) ? decrypt(row.setting_value || '') : row.setting_value,
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
    const { setting_key, category } = req.body;
    // Encrypt secret values before storing
    const setting_value = isSecretKey(setting_key) ? encrypt(req.body.setting_value || '') : req.body.setting_value;

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
      // Encrypt secret values before storing
      const value = isSecretKey(item.setting_key) ? encrypt(item.setting_value || '') : item.setting_value;
      const [existing] = await pool.query(
        'SELECT id FROM site_settings WHERE setting_key = ?',
        [item.setting_key]
      );

      if (Array.isArray(existing) && existing.length > 0) {
        await pool.query(
          'UPDATE site_settings SET setting_value = ?, updated_at = NOW() WHERE setting_key = ?',
          [value, item.setting_key]
        );
      } else {
        const id = require('uuid').v4();
        await pool.query(
          'INSERT INTO site_settings (id, setting_key, setting_value, category) VALUES (?, ?, ?, ?)',
          [id, item.setting_key, value, item.category || 'general']
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
