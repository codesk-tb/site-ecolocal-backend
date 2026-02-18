import { Router } from 'express';
import pool from '../db/connection';
import { authenticate, requireAdmin } from '../middleware/auth';
import { v4 as uuid } from 'uuid';

const router = Router();

// Helper: read a setting from DB
async function getSetting(key: string): Promise<string> {
  const [rows] = await pool.query(
    'SELECT setting_value FROM site_settings WHERE setting_key = ?',
    [key]
  );
  return (rows as any[])[0]?.setting_value || '';
}

// ─── News API providers ───

interface FetchedArticle {
  external_id: string;
  title: string;
  description: string | null;
  source_name: string | null;
  source_url: string | null;
  image_url: string | null;
  published_date: string | null;
}

/** NewsAPI.ai (EventRegistry) */
async function fetchFromNewsApiAi(apiKey: string, keywords: string): Promise<FetchedArticle[]> {
  // EventRegistry supporte keyword comme tableau
  const keywordList = keywords.split(',').map(k => k.trim()).filter(Boolean);

  const body = {
    action: 'getArticles',
    keyword: keywordList,
    keywordOper: 'or',
    lang: 'fra',
    articlesSortBy: 'date',
    articlesCount: 20,
    resultType: 'articles',
    apiKey,
  };

  const resp = await fetch('https://eventregistry.org/api/v1/article/getArticles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`NewsAPI.ai error ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  const articles = data?.articles?.results || [];

  return articles.map((a: any) => ({
    external_id: `newsapiai_${a.uri || a.url || a.title?.slice(0, 50)}`,
    title: a.title || 'Sans titre',
    description: a.body?.slice(0, 500) || a.summary || null,
    source_name: a.source?.title || null,
    source_url: a.url || null,
    image_url: a.image || null,
    published_date: a.dateTime || a.date || null,
  }));
}

/** Google News via SerpAPI */
async function fetchFromGoogleNews(apiKey: string, keywords: string): Promise<FetchedArticle[]> {
  // Google accepte OR entre les termes pour élargir la recherche
  const terms = keywords.split(',').map(k => k.trim()).filter(Boolean);
  const q = encodeURIComponent(terms.length > 1 ? terms.join(' OR ') : terms[0] || keywords);
  const url = `https://serpapi.com/search.json?engine=google_news&q=${q}&gl=fr&hl=fr&api_key=${apiKey}`;

  const resp = await fetch(url);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`SerpAPI error ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  const results = data?.news_results || [];

  return results.slice(0, 20).map((a: any) => ({
    external_id: `google_${a.link || a.title?.slice(0, 50)}`,
    title: a.title || 'Sans titre',
    description: a.snippet || null,
    source_name: a.source?.name || null,
    source_url: a.link || null,
    image_url: a.thumbnail || null,
    published_date: a.date ? new Date(a.date).toISOString() : null,
  }));
}

/** GNews.io (free tier — 100 req/day, no card needed) */
async function fetchFromGNews(apiKey: string, keywords: string): Promise<FetchedArticle[]> {
  // GNews: faire une requête par mot-clé puis fusionner les résultats
  // Car le tier gratuit ne gère pas bien les opérateurs booléens
  const terms = keywords.split(',').map(k => k.trim()).filter(Boolean);

  if (terms.length <= 1) {
    // Un seul mot-clé, requête simple
    const q = encodeURIComponent(terms[0] || keywords);
    const url = `https://gnews.io/api/v4/search?q=${q}&lang=fr&country=fr&max=20&apikey=${apiKey}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`GNews error ${resp.status}: ${text}`);
    }
    const data = await resp.json();
    return (data?.articles || []).map((a: any) => ({
      external_id: `gnews_${a.url || a.title?.slice(0, 50)}`,
      title: a.title || 'Sans titre',
      description: a.description || a.content || null,
      source_name: a.source?.name || null,
      source_url: a.url || null,
      image_url: a.image || null,
      published_date: a.publishedAt || null,
    }));
  }

  // Plusieurs mots-clés: requêtes parallèles puis dédoublonnage
  const perKeyword = Math.max(5, Math.floor(20 / terms.length));
  const allArticles: FetchedArticle[] = [];
  const seenUrls = new Set<string>();

  for (const term of terms) {
    try {
      const q = encodeURIComponent(term);
      const url = `https://gnews.io/api/v4/search?q=${q}&lang=fr&country=fr&max=${perKeyword}&apikey=${apiKey}`;

      const resp = await fetch(url);
      if (!resp.ok) {
        console.error(`GNews error for "${term}": ${resp.status}`);
        continue; // skip this keyword, try next
      }

      const data = await resp.json();
      for (const a of (data?.articles || [])) {
        const artUrl = a.url || a.title?.slice(0, 50);
        if (!seenUrls.has(artUrl)) {
          seenUrls.add(artUrl);
          allArticles.push({
            external_id: `gnews_${artUrl}`,
            title: a.title || 'Sans titre',
            description: a.description || a.content || null,
            source_name: a.source?.name || null,
            source_url: a.url || null,
            image_url: a.image || null,
            published_date: a.publishedAt || null,
          });
        }
      }
    } catch (err) {
      console.error(`GNews fetch error for "${term}":`, err);
      // continue with next keyword
    }
  }

  if (allArticles.length === 0) {
    throw new Error('Aucun résultat trouvé sur GNews pour les mots-clés configurés');
  }

  return allArticles;
}

// GET /api/news — news suggestions
router.get('/', authenticate, requireAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    let query = 'SELECT * FROM news_suggestions';
    const params: any[] = [];
    if (status) {
      query += ' WHERE status = ?';
      params.push(status);
    }
    query += ' ORDER BY created_at DESC';
    const [rows] = await pool.query(query, params);

    // Map DB columns to frontend expected names
    const mapped = (rows as any[]).map(row => ({
      ...row,
      published_at: row.published_date,
      fetched_at: row.created_at,
      created_article_id: row.article_id,
    }));

    res.json(mapped);
  } catch (error) {
    console.error('Get news error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/news/fetch — fetch ecology news from configured provider
router.post('/fetch', authenticate, requireAdmin, async (_req, res) => {
  try {
    const provider = await getSetting('news_import_provider');
    const apiKey = await getSetting('news_api_key');
    const keywords = await getSetting('news_import_keywords') || 'écologie,environnement,développement durable';
    const enabled = await getSetting('news_import_enabled');

    if (!provider || provider === 'none') {
      return res.status(400).json({ 
        error: "Aucun fournisseur d'actualités configuré. Allez dans Paramètres → Import actualités pour en configurer un." 
      });
    }

    if (enabled === 'false') {
      return res.status(400).json({ 
        error: "L'import automatique est désactivé. Activez-le dans Paramètres → Import actualités." 
      });
    }

    if (!apiKey) {
      return res.status(400).json({ 
        error: "Aucune clé API configurée. Ajoutez votre clé API dans Paramètres → Import actualités." 
      });
    }

    // Fetch articles from provider
    let articles: FetchedArticle[] = [];

    switch (provider) {
      case 'newsapi_ai':
        articles = await fetchFromNewsApiAi(apiKey, keywords);
        break;
      case 'google_news':
        articles = await fetchFromGoogleNews(apiKey, keywords);
        break;
      case 'gnews':
        articles = await fetchFromGNews(apiKey, keywords);
        break;
      default:
        return res.status(400).json({ error: `Fournisseur inconnu: ${provider}` });
    }

    if (articles.length === 0) {
      return res.json({ message: 'Aucune nouvelle actualité trouvée', inserted: 0 });
    }

    // Insert only new articles (skip duplicates based on external_id)
    let inserted = 0;
    for (const article of articles) {
      try {
        const [existing] = await pool.query(
          'SELECT id FROM news_suggestions WHERE external_id = ?',
          [article.external_id]
        );

        if ((existing as any[]).length === 0) {
          await pool.query(
            `INSERT INTO news_suggestions (id, external_id, title, description, source_name, source_url, image_url, published_date, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
            [
              uuid(),
              article.external_id,
              article.title,
              article.description,
              article.source_name,
              article.source_url,
              article.image_url,
              article.published_date ? new Date(article.published_date) : null,
            ]
          );
          inserted++;
        }
      } catch (insertErr) {
        console.error('Insert article error:', insertErr);
        // continue with next article
      }
    }

    res.json({ 
      message: `${inserted} nouvelles suggestions ajoutées (${articles.length - inserted} doublons ignorés)`, 
      inserted,
      total: articles.length,
    });
  } catch (error: any) {
    console.error('Fetch news error:', error);
    res.status(500).json({ error: error.message || 'Erreur lors de la récupération des actualités' });
  }
});

// PUT /api/news/:id — update status (approve/reject)
router.put('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const { status, article_id, created_article_id } = req.body;
    const updates: string[] = [];
    const params: any[] = [];

    if (status) { updates.push('status = ?'); params.push(status); }
    // Support both field names (frontend sends created_article_id, DB column is article_id)
    const artId = article_id || created_article_id;
    if (artId) { updates.push('article_id = ?'); params.push(artId); }

    if (updates.length === 0) return res.status(400).json({ error: 'Aucune modification' });

    params.push(req.params.id);
    await pool.query(`UPDATE news_suggestions SET ${updates.join(', ')} WHERE id = ?`, params);

    const [rows] = await pool.query('SELECT * FROM news_suggestions WHERE id = ?', [req.params.id]);
    const row = (rows as any[])[0];
    if (row) {
      row.published_at = row.published_date;
      row.fetched_at = row.created_at;
      row.created_article_id = row.article_id;
    }
    res.json(row);
  } catch (error) {
    console.error('Update news error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /api/news/:id
router.delete('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM news_suggestions WHERE id = ?', [req.params.id]);
    res.json({ message: 'Suggestion supprimée' });
  } catch (error) {
    console.error('Delete news error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

export default router;
