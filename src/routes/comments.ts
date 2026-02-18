import { Router } from 'express';
import pool from '../db/connection';
import { authenticate, requireAdmin } from '../middleware/auth';

const router = Router();

// GET comments for an article or project
router.get('/', async (req, res) => {
  try {
    const { article_id, project_id, approved } = req.query;
    const params: any[] = [];
    const conditions: string[] = [];

    if (article_id) { conditions.push('c.article_id = ?'); params.push(article_id); }
    if (project_id) { conditions.push('c.project_id = ?'); params.push(project_id); }
    if (approved !== undefined) { conditions.push('c.approved = ?'); params.push(approved === 'true'); }

    const where = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';

    const [rows] = await pool.query(
      `SELECT c.*, u.full_name, u.first_name, u.last_name, u.avatar_url, u.email
       FROM comments c LEFT JOIN users u ON c.user_id = u.id` + where + ' ORDER BY c.created_at DESC',
      params
    );
    res.json(rows);
  } catch (error) {
    console.error('Get comments error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST new comment
router.post('/', authenticate, async (req, res) => {
  try {
    const { content, article_id, project_id } = req.body;
    if (!content) return res.status(400).json({ error: 'Contenu requis' });
    
    const id = require('uuid').v4();
    await pool.query(
      'INSERT INTO comments (id, content, user_id, article_id, project_id, approved) VALUES (?, ?, ?, ?, ?, false)',
      [id, content, req.user!.id, article_id || null, project_id || null]
    );

    const [rows] = await pool.query(
      `SELECT c.*, u.full_name, u.first_name, u.last_name, u.avatar_url
       FROM comments c LEFT JOIN users u ON c.user_id = u.id WHERE c.id = ?`,
      [id]
    );
    res.status(201).json((rows as any[])[0]);
  } catch (error) {
    console.error('Create comment error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT approve/update comment - admin
router.put('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const { approved, content } = req.body;
    const updates: string[] = [];
    const params: any[] = [];

    if (approved !== undefined) { updates.push('approved = ?'); params.push(approved); }
    if (content !== undefined) { updates.push('content = ?'); params.push(content); }

    if (updates.length === 0) return res.status(400).json({ error: 'Aucune modification' });

    params.push(req.params.id);
    await pool.query(`UPDATE comments SET ${updates.join(', ')} WHERE id = ?`, params);

    const [rows] = await pool.query('SELECT * FROM comments WHERE id = ?', [req.params.id]);
    res.json((rows as any[])[0]);
  } catch (error) {
    console.error('Update comment error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE comment
router.delete('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM comments WHERE id = ?', [req.params.id]);
    res.json({ message: 'Commentaire supprimé' });
  } catch (error) {
    console.error('Delete comment error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

export default router;
