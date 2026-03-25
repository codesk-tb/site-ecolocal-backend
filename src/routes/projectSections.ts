import express, { Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import pool from '../db/connection';
import { authenticate, requireAdmin } from '../middleware/auth';

const router = express.Router();

async function ensureProjectSectionColorColumns() {
  try {
    await pool.query('ALTER TABLE project_sections ADD COLUMN title_color VARCHAR(7) DEFAULT "#000000"');
  } catch (err: any) {
    if (err?.code !== 'ER_DUP_FIELDNAME') throw err;
  }
  try {
    await pool.query('ALTER TABLE project_sections ADD COLUMN description_color VARCHAR(7) DEFAULT "#666666"');
  } catch (err: any) {
    if (err?.code !== 'ER_DUP_FIELDNAME') throw err;
  }
  try {
    await pool.query('ALTER TABLE project_sections ADD COLUMN title_html TEXT');
  } catch (err: any) {
    if (err?.code !== 'ER_DUP_FIELDNAME') throw err;
  }
  try {
    await pool.query('ALTER TABLE project_sections ADD COLUMN main_image_urls TEXT');
  } catch (err: any) {
    if (err?.code !== 'ER_DUP_FIELDNAME') throw err;
  }
  try {
    await pool.query('ALTER TABLE project_sections ADD COLUMN thumbnail_position VARCHAR(10) DEFAULT "right"');
  } catch (err: any) {
    if (err?.code !== 'ER_DUP_FIELDNAME') throw err;
  }
}

function normalizeMainImageUrls(value: unknown): string {
  let list: string[] = [];
  if (Array.isArray(value)) {
    list = value.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean);
  } else if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        list = parsed.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean);
      }
    } catch {
      list = [];
    }
  }
  return JSON.stringify(list.slice(0, 5));
}

// GET all published project sections
router.get('/', async (req: Request, res: Response) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM project_sections WHERE published = 1 ORDER BY display_order ASC'
    );
    res.json(rows);
  } catch (err) {
    console.error('Error fetching project sections:', err);
    res.status(500).json({ error: 'Error fetching project sections' });
  }
});

// GET all project sections (including drafts) — admin only
router.get('/admin/all', [authenticate, requireAdmin], async (req: Request, res: Response) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM project_sections ORDER BY display_order ASC'
    );
    res.json(rows);
  } catch (err) {
    console.error('Error fetching all project sections:', err);
    res.status(500).json({ error: 'Error fetching project sections' });
  }
});

// POST create project section — admin only
router.post('/', [authenticate, requireAdmin], async (req: Request, res: Response) => {
  try {
    await ensureProjectSectionColorColumns();
    const {
      title,
      title_html,
      description,
      main_image_url,
      main_image_urls,
      thumbnail_image_url,
      thumbnail_position,
      link_url,
      layout,
      title_color,
      description_color,
    } = req.body;
    const id = uuid();
    const display_order = 0;
    const published = true;

    const normalizedMainImageUrls = normalizeMainImageUrls(main_image_urls);
    let normalizedMainImageUrl = (main_image_url || '').trim();
    try {
      const parsed = JSON.parse(normalizedMainImageUrls) as string[];
      if (!normalizedMainImageUrl && parsed.length > 0) {
        normalizedMainImageUrl = parsed[0];
      }
    } catch {
      // no-op
    }

    await pool.query(
      'INSERT INTO project_sections (id, title, title_html, description, main_image_url, main_image_urls, thumbnail_image_url, thumbnail_position, link_url, layout, title_color, description_color, display_order, published) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        id,
        title || '',
        title_html || '',
        description || '',
        normalizedMainImageUrl,
        normalizedMainImageUrls,
        thumbnail_image_url || '',
        (thumbnail_position === 'left' ? 'left' : 'right'),
        link_url || '',
        layout || 'text-right',
        title_color || '#000000',
        description_color || '#666666',
        display_order,
        published ? 1 : 0,
      ]
    );

    res.json({
      id,
      title,
      title_html,
      description,
      main_image_url: normalizedMainImageUrl,
      main_image_urls: normalizedMainImageUrls,
      thumbnail_image_url,
      thumbnail_position: (thumbnail_position === 'left' ? 'left' : 'right'),
      link_url,
      layout,
      title_color: title_color || '#000000',
      description_color: description_color || '#666666',
      display_order,
      published,
    });
  } catch (err) {
    console.error('Error creating project section:', err);
    res.status(500).json({ error: 'Error creating project section' });
  }
});

// PUT update project section — admin only
router.put('/:id', [authenticate, requireAdmin], async (req: Request, res: Response) => {
  try {
    await ensureProjectSectionColorColumns();
    const { id } = req.params;
    const {
      title,
      title_html,
      description,
      main_image_url,
      main_image_urls,
      thumbnail_image_url,
      thumbnail_position,
      link_url,
      layout,
      title_color,
      description_color,
      published,
    } = req.body;

    const normalizedMainImageUrls = normalizeMainImageUrls(main_image_urls);
    let normalizedMainImageUrl = (main_image_url || '').trim();
    try {
      const parsed = JSON.parse(normalizedMainImageUrls) as string[];
      if (!normalizedMainImageUrl && parsed.length > 0) {
        normalizedMainImageUrl = parsed[0];
      }
    } catch {
      // no-op
    }

    await pool.query(
      'UPDATE project_sections SET title = ?, title_html = ?, description = ?, main_image_url = ?, main_image_urls = ?, thumbnail_image_url = ?, thumbnail_position = ?, link_url = ?, layout = ?, title_color = ?, description_color = ?, published = ? WHERE id = ?',
      [
        title || '',
        title_html || '',
        description || '',
        normalizedMainImageUrl,
        normalizedMainImageUrls,
        thumbnail_image_url || '',
        (thumbnail_position === 'left' ? 'left' : 'right'),
        link_url || '',
        layout || 'text-right',
        title_color || '#000000',
        description_color || '#666666',
        published ? 1 : 0,
        id,
      ]
    );

    res.json({
      id,
      title,
      title_html,
      description,
      main_image_url: normalizedMainImageUrl,
      main_image_urls: normalizedMainImageUrls,
      thumbnail_image_url,
      thumbnail_position: (thumbnail_position === 'left' ? 'left' : 'right'),
      link_url,
      layout,
      title_color: title_color || '#000000',
      description_color: description_color || '#666666',
      published,
    });
  } catch (err) {
    console.error('Error updating project section:', err);
    res.status(500).json({ error: 'Error updating project section' });
  }
});

// PUT reorder project section — admin only (specific route before generic /:id)
router.put('/reorder/:id', [authenticate, requireAdmin], async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { display_order } = req.body;

    await pool.query(
      'UPDATE project_sections SET display_order = ? WHERE id = ?',
      [display_order || 0, id]
    );

    res.json({ id, display_order: display_order || 0 });
  } catch (err) {
    console.error('Error reordering project section:', err);
    res.status(500).json({ error: 'Error reordering project section' });
  }
});

// DELETE project section — admin only
router.delete('/:id', [authenticate, requireAdmin], async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM project_sections WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting project section:', err);
    res.status(500).json({ error: 'Error deleting project section' });
  }
});

export default router;
