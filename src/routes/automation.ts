import { Router } from 'express';
import pool from '../db/connection';
import { authenticate, requireAdmin } from '../middleware/auth';
import { decryptSettings } from '../utils/crypto';

const router = Router();

// ─── Helpers ──────────────────────────────────────────────────

async function getAutomationSettings(): Promise<Record<string, string>> {
  const [rows] = await pool.query(
    "SELECT setting_key, setting_value FROM site_settings WHERE category = 'automation'"
  );
  const settings: Record<string, string> = {};
  (rows as any[]).forEach((r: any) => {
    settings[r.setting_key] = r.setting_value || '';
  });
  return decryptSettings(settings);
}

/**
 * Post a link + message to a Facebook Page
 */
export async function postToFacebook(
  pageId: string,
  accessToken: string,
  message: string,
  link: string
): Promise<{ id: string }> {
  const res = await fetch(`https://graph.facebook.com/v19.0/${pageId}/feed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      link,
      access_token: accessToken,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error?.message || JSON.stringify(data));
  }
  return data;
}

/**
 * Post an image + caption to Instagram Business via Facebook Graph API
 * Step 1: Create media container
 * Step 2: Publish the container
 */
export async function postToInstagram(
  igAccountId: string,
  accessToken: string,
  caption: string,
  imageUrl: string
): Promise<{ id: string }> {
  // Step 1 — Create media container
  const createRes = await fetch(`https://graph.facebook.com/v19.0/${igAccountId}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image_url: imageUrl,
      caption,
      access_token: accessToken,
    }),
  });
  const createData = await createRes.json();
  if (!createRes.ok) {
    throw new Error(createData.error?.message || JSON.stringify(createData));
  }

  // Step 2 — Publish
  const publishRes = await fetch(`https://graph.facebook.com/v19.0/${igAccountId}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      creation_id: createData.id,
      access_token: accessToken,
    }),
  });
  const publishData = await publishRes.json();
  if (!publishRes.ok) {
    throw new Error(publishData.error?.message || JSON.stringify(publishData));
  }
  return publishData;
}

/**
 * Auto-post an article to Facebook and/or Instagram
 * Called after creating/publishing an article
 */
export async function autoPostArticle(articleId: string, siteUrl?: string) {
  try {
    const settings = await getAutomationSettings();

    if (settings.auto_post_enabled !== 'true') return;

    const pageToken = settings.fb_page_access_token;
    const pageId = settings.fb_page_id;
    const igAccountId = settings.ig_business_account_id;

    if (!pageToken || !pageId) return;

    // Get article data
    const [rows] = await pool.query(
      'SELECT title, slug, excerpt, image_url FROM articles WHERE id = ? AND published = true',
      [articleId]
    );
    const article = (rows as any[])[0];
    if (!article) return;

    // Get site URL
    let baseUrl = siteUrl || '';
    if (!baseUrl) {
      const [urlRows] = await pool.query(
        "SELECT setting_value FROM site_settings WHERE setting_key = 'site_url'"
      );
      baseUrl = (urlRows as any[])[0]?.setting_value || 'http://localhost:3000';
    }

    const articleUrl = `${baseUrl}/actualites/${article.slug}`;
    const message = article.excerpt
      ? `${article.title}\n\n${article.excerpt}\n\n👉 Lire l'article : ${articleUrl}`
      : `${article.title}\n\n👉 Lire l'article : ${articleUrl}`;

    const uuid = require('uuid').v4;

    // ─── Facebook ───────────────────────────────────────────
    if (settings.auto_post_facebook === 'true') {
      try {
        const fbResult = await postToFacebook(pageId, pageToken, message, articleUrl);
        await pool.query(
          'INSERT INTO social_posts_log (id, article_id, platform, post_id, status) VALUES (?, ?, ?, ?, ?)',
          [uuid(), articleId, 'facebook', fbResult.id, 'success']
        );
        console.log(`✅ Article posted to Facebook: ${fbResult.id}`);
      } catch (err: any) {
        await pool.query(
          'INSERT INTO social_posts_log (id, article_id, platform, status, error_message) VALUES (?, ?, ?, ?, ?)',
          [uuid(), articleId, 'facebook', 'error', err.message]
        );
        console.error(`❌ Facebook post error:`, err.message);
      }
    }

    // ─── Instagram ──────────────────────────────────────────
    if (settings.auto_post_instagram === 'true' && igAccountId) {
      // Instagram requires a public image URL
      const imageUrl = article.image_url
        ? (article.image_url.startsWith('http') ? article.image_url : `${baseUrl}${article.image_url}`)
        : null;

      if (imageUrl) {
        try {
          const igResult = await postToInstagram(igAccountId, pageToken, message, imageUrl);
          await pool.query(
            'INSERT INTO social_posts_log (id, article_id, platform, post_id, status) VALUES (?, ?, ?, ?, ?)',
            [uuid(), articleId, 'instagram', igResult.id, 'success']
          );
          console.log(`✅ Article posted to Instagram: ${igResult.id}`);
        } catch (err: any) {
          await pool.query(
            'INSERT INTO social_posts_log (id, article_id, platform, status, error_message) VALUES (?, ?, ?, ?, ?)',
            [uuid(), articleId, 'instagram', 'error', err.message]
          );
          console.error(`❌ Instagram post error:`, err.message);
        }
      } else {
        console.warn('⚠️ Instagram post skipped: no image on the article');
      }
    }
  } catch (err) {
    console.error('Auto-post error:', err);
  }
}

// ─── Admin API Routes ─────────────────────────────────────────

// POST /api/automation/test — test Facebook Graph API connection
router.post('/test', authenticate, requireAdmin, async (_req, res) => {
  try {
    const settings = await getAutomationSettings();
    const token = settings.fb_page_access_token;
    const pageId = settings.fb_page_id;

    if (!token || !pageId) {
      return res.status(400).json({ error: 'Token et ID de page requis' });
    }

    // Test page access
    const fbRes = await fetch(
      `https://graph.facebook.com/v19.0/${pageId}?fields=name,id,access_token&access_token=${token}`
    );
    const fbData = await fbRes.json();

    if (!fbRes.ok) {
      return res.status(400).json({
        error: 'Erreur de connexion Facebook',
        details: fbData.error?.message || JSON.stringify(fbData),
      });
    }

    const result: any = {
      facebook: { connected: true, pageName: fbData.name, pageId: fbData.id },
    };

    // Test Instagram if configured
    const igId = settings.ig_business_account_id;
    if (igId) {
      const igRes = await fetch(
        `https://graph.facebook.com/v19.0/${igId}?fields=name,username,profile_picture_url&access_token=${token}`
      );
      const igData = await igRes.json();
      if (igRes.ok) {
        result.instagram = { connected: true, username: igData.username, name: igData.name };
      } else {
        result.instagram = { connected: false, error: igData.error?.message };
      }
    }

    res.json(result);
  } catch (error: any) {
    console.error('Automation test error:', error);
    res.status(500).json({ error: error.message || 'Erreur serveur' });
  }
});

// GET /api/automation/logs — get social post logs
router.get('/logs', authenticate, requireAdmin, async (req, res) => {
  try {
    const { page = '1', limit = '20' } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    const [countRows] = await pool.query('SELECT COUNT(*) as total FROM social_posts_log');
    const total = (countRows as any[])[0]?.total || 0;

    const [rows] = await pool.query(
      `SELECT l.*, a.title as article_title, a.slug as article_slug
       FROM social_posts_log l
       LEFT JOIN articles a ON l.article_id = a.id
       ORDER BY l.created_at DESC
       LIMIT ? OFFSET ?`,
      [Number(limit), offset]
    );

    res.json({ data: rows, total, page: Number(page), limit: Number(limit) });
  } catch (error) {
    console.error('Get automation logs error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/automation/post/:articleId — manually post an article to social media
router.post('/post/:articleId', authenticate, requireAdmin, async (req, res) => {
  try {
    const { articleId } = req.params;
    const { platforms } = req.body; // ['facebook', 'instagram'] or undefined = both

    const settings = await getAutomationSettings();
    const pageToken = settings.fb_page_access_token;
    const pageId = settings.fb_page_id;
    const igAccountId = settings.ig_business_account_id;

    if (!pageToken || !pageId) {
      return res.status(400).json({ error: 'Token et ID de page Facebook requis' });
    }

    // Get article
    const [rows] = await pool.query('SELECT title, slug, excerpt, image_url FROM articles WHERE id = ?', [articleId]);
    const article = (rows as any[])[0];
    if (!article) {
      return res.status(404).json({ error: 'Article non trouvé' });
    }

    // Get site URL
    const [urlRows] = await pool.query("SELECT setting_value FROM site_settings WHERE setting_key = 'site_url'");
    const baseUrl = (urlRows as any[])[0]?.setting_value || 'http://localhost:3000';
    const articleUrl = `${baseUrl}/actualites/${article.slug}`;
    const message = article.excerpt
      ? `${article.title}\n\n${article.excerpt}\n\n👉 Lire l'article : ${articleUrl}`
      : `${article.title}\n\n👉 Lire l'article : ${articleUrl}`;

    const uuid = require('uuid').v4;
    const results: any = {};
    const doFb = !platforms || platforms.includes('facebook');
    const doIg = !platforms || platforms.includes('instagram');

    if (doFb) {
      try {
        const fbResult = await postToFacebook(pageId, pageToken, message, articleUrl);
        await pool.query(
          'INSERT INTO social_posts_log (id, article_id, platform, post_id, status) VALUES (?, ?, ?, ?, ?)',
          [uuid(), articleId, 'facebook', fbResult.id, 'success']
        );
        results.facebook = { success: true, postId: fbResult.id };
      } catch (err: any) {
        await pool.query(
          'INSERT INTO social_posts_log (id, article_id, platform, status, error_message) VALUES (?, ?, ?, ?, ?)',
          [uuid(), articleId, 'facebook', 'error', err.message]
        );
        results.facebook = { success: false, error: err.message };
      }
    }

    if (doIg && igAccountId) {
      const imageUrl = article.image_url
        ? (article.image_url.startsWith('http') ? article.image_url : `${baseUrl}${article.image_url}`)
        : null;

      if (imageUrl) {
        try {
          const igResult = await postToInstagram(igAccountId, pageToken, message, imageUrl);
          await pool.query(
            'INSERT INTO social_posts_log (id, article_id, platform, post_id, status) VALUES (?, ?, ?, ?, ?)',
            [uuid(), articleId, 'instagram', igResult.id, 'success']
          );
          results.instagram = { success: true, postId: igResult.id };
        } catch (err: any) {
          await pool.query(
            'INSERT INTO social_posts_log (id, article_id, platform, status, error_message) VALUES (?, ?, ?, ?, ?)',
            [uuid(), articleId, 'instagram', 'error', err.message]
          );
          results.instagram = { success: false, error: err.message };
        }
      } else {
        results.instagram = { success: false, error: 'Pas d\'image sur l\'article (requis pour Instagram)' };
      }
    }

    res.json(results);
  } catch (error: any) {
    console.error('Manual post error:', error);
    res.status(500).json({ error: error.message || 'Erreur serveur' });
  }
});

export default router;
