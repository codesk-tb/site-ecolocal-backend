import { Router } from 'express';
import pool from '../db/connection';
import { authenticate, optionalAuth, requireAdmin } from '../middleware/auth';
import { autoPostArticle } from './automation';

const router = Router();

// GET /api/articles — public list with optional category, search, pagination
router.get('/', optionalAuth, async (req, res) => {
  try {
    const { category, search, page = '1', limit = '12', published } = req.query;
    const offset = (Number(page) - 1) * Number(limit);
    
    let query = `SELECT a.*, c.name as category_name, c.slug as category_slug,
      (SELECT COUNT(*) FROM comments WHERE article_id = a.id AND approved = true) as comment_count
      FROM articles a
      LEFT JOIN categories c ON a.category_id = c.id`;
    const params: any[] = [];
    const conditions: string[] = [];

    // For non-admin, only show published
    if (published !== 'all') {
      conditions.push('a.published = true');
    }

    if (category) {
      conditions.push('c.slug = ?');
      params.push(category);
    }

    if (search) {
      conditions.push('(a.title LIKE ? OR a.excerpt LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    // Count total
    const countQuery = query.replace(/SELECT a\.\*.*FROM/, 'SELECT COUNT(*) as total FROM');
    const [countRows] = await pool.query(countQuery, params);
    const total = (countRows as any[])[0]?.total || 0;

    query += ' ORDER BY a.created_at DESC LIMIT ? OFFSET ?';
    params.push(Number(limit), offset);

    const [rows] = await pool.query(query, params);

    res.json({ data: rows, total, page: Number(page), limit: Number(limit) });
  } catch (error) {
    console.error('Get articles error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/articles/:slug
router.get('/:slug', optionalAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, c.name as category_name, c.slug as category_slug
       FROM articles a
       LEFT JOIN categories c ON a.category_id = c.id
       WHERE a.slug = ?`,
      [req.params.slug]
    );
    const articles = rows as any[];
    
    if (articles.length === 0) {
      return res.status(404).json({ error: 'Article non trouvé' });
    }

    const article = articles[0];

    // Check members_only access
    if (article.members_only && !req.user) {
      return res.status(403).json({ error: 'Contenu réservé aux membres' });
    }

    // Increment view count
    await pool.query('UPDATE articles SET view_count = view_count + 1 WHERE id = ?', [article.id]);

    // Get documents
    const [docs] = await pool.query('SELECT * FROM documents WHERE article_id = ?', [article.id]);

    res.json({ ...article, documents: docs });
  } catch (error) {
    console.error('Get article error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/articles — admin only
router.post('/', authenticate, requireAdmin, async (req, res) => {
  try {
    const { title, slug, excerpt, content, image_url, video_url, category_id, published, members_only, background_color } = req.body;
    const isPublished = published ?? false;
    const authorId = req.user?.id || null;
    
    const id = require('uuid').v4();
    await pool.query(
      `INSERT INTO articles (id, title, slug, excerpt, content, image_url, video_url, category_id, published, members_only, background_color, author_id, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, title, slug, excerpt || null, content || null, image_url || null, video_url || null, category_id || null, isPublished, members_only ?? false, background_color || null, authorId, isPublished ? new Date() : null]
    );

    const [rows] = await pool.query('SELECT * FROM articles WHERE id = ?', [id]);
    const created = (rows as any[])[0];

    // Auto-post to social media if published
    if (isPublished) {
      autoPostArticle(id).catch(err => console.error('Auto-post error:', err));
    }

    res.status(201).json(created);
  } catch (error) {
    console.error('Create article error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/articles/:id — admin only
router.put('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const { title, slug, excerpt, content, image_url, video_url, category_id, published, members_only, background_color } = req.body;
    const isPublished = published ?? false;

    // If publishing for the first time, set published_at
    let publishedAtClause = '';
    const updateParams: any[] = [title, slug, excerpt || null, content || null, image_url || null, video_url || null, category_id || null, isPublished, members_only ?? false, background_color || null];
    if (isPublished) {
      publishedAtClause = ', published_at = COALESCE(published_at, NOW())';
    } else {
      publishedAtClause = ', published_at = NULL';
    }
    
    await pool.query(
      `UPDATE articles SET title = ?, slug = ?, excerpt = ?, content = ?, image_url = ?, video_url = ?,
       category_id = ?, published = ?, members_only = ?, background_color = ?, updated_at = NOW()${publishedAtClause}
       WHERE id = ?`,
      [...updateParams, req.params.id]
    );

    const [rows] = await pool.query('SELECT * FROM articles WHERE id = ?', [req.params.id]);
    const updated = (rows as any[])[0];

    // Auto-post to social media if just published (check no prior social post log)
    if (isPublished) {
      const [existingPosts] = await pool.query(
        'SELECT id FROM social_posts_log WHERE article_id = ? LIMIT 1',
        [req.params.id]
      );
      if (Array.isArray(existingPosts) && existingPosts.length === 0) {
        autoPostArticle(req.params.id).catch(err => console.error('Auto-post error:', err));
      }
    }

    res.json(updated);
  } catch (error) {
    console.error('Update article error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /api/articles/:id — admin only
router.delete('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM articles WHERE id = ?', [req.params.id]);
    res.json({ message: 'Article supprimé' });
  } catch (error) {
    console.error('Delete article error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

export default router;
