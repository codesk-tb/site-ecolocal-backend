import { Router } from 'express';
import pool from '../db/connection';
import { authenticate, requireAdmin, optionalAuth } from '../middleware/auth';

const router = Router();

// GET /api/projects
router.get('/', async (req, res) => {
  try {
    const { status, search, page = '1', limit = '12', published } = req.query;
    const offset = (Number(page) - 1) * Number(limit);
    const params: any[] = [];
    const conditions: string[] = [];

    if (published !== 'all') {
      conditions.push('published = true');
    }
    if (status) {
      conditions.push('status = ?');
      params.push(status);
    }
    if (search) {
      conditions.push('(title LIKE ? OR description LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }

    let where = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';

    const [countRows] = await pool.query('SELECT COUNT(*) as total FROM projects' + where, params);
    const total = (countRows as any[])[0]?.total || 0;

    const [rows] = await pool.query(
      'SELECT * FROM projects' + where + ' ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [...params, Number(limit), offset]
    );

    res.json({ data: rows, total, page: Number(page), limit: Number(limit) });
  } catch (error) {
    console.error('Get projects error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/projects/:slug
router.get('/:slug', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM projects WHERE slug = ?', [req.params.slug]);
    const projects = rows as any[];
    
    if (projects.length === 0) {
      return res.status(404).json({ error: 'Projet non trouvé' });
    }

    const project = projects[0];

    // Get documents
    const [docs] = await pool.query('SELECT * FROM documents WHERE project_id = ?', [project.id]);
    // Get comments
    const [comments] = await pool.query(
      `SELECT c.*, u.full_name, u.first_name, u.last_name, u.avatar_url
       FROM comments c LEFT JOIN users u ON c.user_id = u.id
       WHERE c.project_id = ? AND c.approved = true ORDER BY c.created_at DESC`,
      [project.id]
    );

    res.json({ ...project, documents: docs, comments });
  } catch (error) {
    console.error('Get project error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/projects
router.post('/', authenticate, requireAdmin, async (req, res) => {
  try {
    const { title, slug, description, content, image_url, video_url, status, start_date, end_date, published } = req.body;
    const id = require('uuid').v4();
    
    await pool.query(
      `INSERT INTO projects (id, title, slug, description, content, image_url, video_url, status, start_date, end_date, published)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, title, slug, description || null, content || null, image_url || null, video_url || null, status || 'ongoing', start_date || null, end_date || null, published ?? false]
    );

    const [rows] = await pool.query('SELECT * FROM projects WHERE id = ?', [id]);
    res.status(201).json((rows as any[])[0]);
  } catch (error) {
    console.error('Create project error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/projects/:id
router.put('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const body = req.body;
    const fields: string[] = [];
    const params: any[] = [];

    const fieldMap: Record<string, (v: any) => any> = {
      title: v => v,
      slug: v => v,
      description: v => v || null,
      content: v => v || null,
      image_url: v => v || null,
      video_url: v => v || null,
      status: v => v || 'ongoing',
      start_date: v => v || null,
      end_date: v => v || null,
      published: v => v ?? false,
    };

    for (const [key, transform] of Object.entries(fieldMap)) {
      if (key in body) {
        fields.push(`${key} = ?`);
        params.push(transform(body[key]));
      }
    }

    if (fields.length === 0) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour' });
    }

    fields.push('updated_at = NOW()');
    params.push(req.params.id);

    await pool.query(
      `UPDATE projects SET ${fields.join(', ')} WHERE id = ?`,
      params
    );

    const [rows] = await pool.query('SELECT * FROM projects WHERE id = ?', [req.params.id]);
    res.json((rows as any[])[0]);
  } catch (error) {
    console.error('Update project error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /api/projects/:id
router.delete('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM projects WHERE id = ?', [req.params.id]);
    res.json({ message: 'Projet supprimé' });
  } catch (error) {
    console.error('Delete project error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

export default router;
