import { Router } from 'express';
import nodemailer from 'nodemailer';
import pool from '../db/connection';
import { authenticate, requireAdmin } from '../middleware/auth';

const router = Router();

// ─── Helpers ───

async function getEmailSettings(): Promise<Record<string, string>> {
  const [rows] = await pool.query(
    "SELECT setting_key, setting_value FROM site_settings WHERE category = 'emails'"
  );
  const settings: Record<string, string> = {};
  for (const row of rows as any[]) {
    settings[row.setting_key] = row.setting_value || '';
  }
  return settings;
}

async function getSetting(key: string): Promise<string> {
  const [rows] = await pool.query(
    'SELECT setting_value FROM site_settings WHERE setting_key = ? LIMIT 1', [key]
  ) as any[];
  return rows[0]?.setting_value || '';
}

function createTransporter(settings: Record<string, string>) {
  const host = settings.email_smtp_host;
  const port = parseInt(settings.email_smtp_port || '587');
  const secure = settings.email_smtp_secure === 'true';
  const user = settings.email_smtp_user;
  const pass = settings.email_smtp_pass;
  if (!host || !user || !pass) return null;
  return nodemailer.createTransport({
    host, port, secure,
    auth: { user, pass },
    tls: { rejectUnauthorized: false },
  });
}

// ─── GET /newsletter — list subscribers ───

router.get('/', authenticate, requireAdmin, async (_req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM newsletter_subscribers ORDER BY subscribed_at DESC'
    );
    res.json(rows);
  } catch (error) {
    console.error('Get subscribers error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── PUT /newsletter/:id/toggle — admin toggle subscribe/unsubscribe ───

router.put('/:id/toggle', authenticate, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.query('SELECT * FROM newsletter_subscribers WHERE id = ?', [id]);
    const sub = (rows as any[])[0];
    if (!sub) return res.status(404).json({ error: 'Abonné non trouvé' });

    if (sub.unsubscribed_at) {
      await pool.query('UPDATE newsletter_subscribers SET unsubscribed_at = NULL WHERE id = ?', [id]);
      res.json({ message: 'Réabonné', unsubscribed_at: null });
    } else {
      await pool.query('UPDATE newsletter_subscribers SET unsubscribed_at = NOW() WHERE id = ?', [id]);
      res.json({ message: 'Désabonné', unsubscribed_at: new Date().toISOString() });
    }
  } catch (error) {
    console.error('Toggle subscriber error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── DELETE /newsletter/:id — admin delete subscriber ───

router.delete('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM newsletter_subscribers WHERE id = ?', [req.params.id]);
    res.json({ message: 'Abonné supprimé' });
  } catch (error) {
    console.error('Delete subscriber error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── GET /newsletter/monthly-content — articles, events, projects from this month ───

router.get('/monthly-content', authenticate, requireAdmin, async (req, res) => {
  try {
    const { year, month } = req.query;
    const y = year ? Number(year) : new Date().getFullYear();
    const m = month ? Number(month) : new Date().getMonth() + 1;

    const startDate = `${y}-${String(m).padStart(2, '0')}-01`;
    const endDate = m === 12
      ? `${y + 1}-01-01`
      : `${y}-${String(m + 1).padStart(2, '0')}-01`;

    const [articles] = await pool.query(
      `SELECT id, title, slug, excerpt, image_url, created_at
       FROM articles WHERE published = true AND created_at >= ? AND created_at < ?
       ORDER BY created_at DESC`, [startDate, endDate]
    );

    const [events] = await pool.query(
      `SELECT id, title, slug, description, image_url, event_date, location, created_at
       FROM events WHERE published = true AND (
         (event_date >= ? AND event_date < ?) OR (created_at >= ? AND created_at < ?)
       )
       ORDER BY event_date ASC`, [startDate, endDate, startDate, endDate]
    );

    const [projects] = await pool.query(
      `SELECT id, title, slug, description, image_url, status, created_at
       FROM projects WHERE published = true AND created_at >= ? AND created_at < ?
       ORDER BY created_at DESC`, [startDate, endDate]
    );

    res.json({ articles, events, projects, year: y, month: m });
  } catch (error) {
    console.error('Get monthly content error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── POST /newsletter/send — send newsletter to all subscribers ───

router.post('/send', authenticate, requireAdmin, async (req, res) => {
  try {
    const { subject, introText, articles, events, projects } = req.body;
    if (!subject) return res.status(400).json({ error: 'Sujet requis' });

    const emailSettings = await getEmailSettings();
    if (emailSettings.newsletter_enabled !== 'true') {
      return res.status(400).json({ error: 'La newsletter est désactivée. Activez-la dans Paramètres → Emails / Newsletter.' });
    }
    if (emailSettings.email_provider !== 'nodemailer') {
      return res.status(400).json({ error: 'Le fournisseur email doit être configuré sur Nodemailer (SMTP) dans les paramètres' });
    }

    const transporter = createTransporter(emailSettings);
    if (!transporter) {
      return res.status(400).json({ error: 'Configuration SMTP incomplète. Vérifiez les paramètres email.' });
    }

    // Get subscribers
    const [subscribers] = await pool.query(
      'SELECT email FROM newsletter_subscribers WHERE unsubscribed_at IS NULL'
    );
    const emails = (subscribers as any[]).map((s: any) => s.email);
    if (emails.length === 0) {
      return res.status(400).json({ error: 'Aucun abonné à la newsletter' });
    }

    // Get site info
    const siteName = await getSetting('site_name') || 'Site Web';
    const siteUrl = await getSetting('site_url') || '';
    const primaryColor = await getSetting('primary_color') || '#166534';
    const fromName = emailSettings.email_from_name || siteName;
    const fromEmail = emailSettings.email_smtp_user;

    // Build HTML
    const html = buildNewsletterHtml({
      siteName, siteUrl, primaryColor,
      subject, introText: introText || '',
      articles: articles || [],
      events: events || [],
      projects: projects || [],
    });

    // Send to each subscriber (BCC approach for small lists, individual for unsubscribe link)
    let sent = 0;
    let failed = 0;

    for (const email of emails) {
      try {
        await transporter.sendMail({
          from: `${fromName} <${fromEmail}>`,
          to: email,
          subject,
          html: html.replace('{{EMAIL}}', encodeURIComponent(email)),
          text: `${subject}\n\n${introText || ''}\n\nPour vous désabonner: ${siteUrl}/api/newsletter/unsubscribe-link?email=${encodeURIComponent(email)}`,
        });
        sent++;
      } catch (err) {
        console.error(`Failed to send to ${email}:`, err);
        failed++;
      }
    }

    // Log the send
    const id = require('uuid').v4();
    await pool.query(
      'INSERT INTO newsletter_sends (id, subject, intro_text, content_json, sent_count, failed_count) VALUES (?, ?, ?, ?, ?, ?)',
      [id, subject, introText || '', JSON.stringify({ articles, events, projects }), sent, failed]
    );

    res.json({ message: `Newsletter envoyée à ${sent} abonné(s)`, sent, failed, total: emails.length });
  } catch (error) {
    console.error('Send newsletter error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── GET /newsletter/sends — history of sent newsletters ───

router.get('/sends', authenticate, requireAdmin, async (_req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM newsletter_sends ORDER BY sent_at DESC LIMIT 50'
    );
    res.json(rows);
  } catch (error) {
    console.error('Get sends error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── GET /newsletter/unsubscribe-link — one-click unsubscribe from email ───

router.get('/unsubscribe-link', async (req, res) => {
  try {
    const email = req.query.email as string;
    if (!email) return res.status(400).send('Email manquant');
    await pool.query(
      'UPDATE newsletter_subscribers SET unsubscribed_at = NOW() WHERE email = ?',
      [decodeURIComponent(email)]
    );
    const siteName = await getSetting('site_name') || 'Site Web';
    res.send(`
      <html><body style="font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#f9fafb;">
        <div style="text-align:center;padding:40px;background:white;border-radius:12px;box-shadow:0 2px 10px rgba(0,0,0,0.1);">
          <h2>Désabonnement confirmé</h2>
          <p>Vous avez été désabonné de la newsletter <strong>${siteName}</strong>.</p>
        </div>
      </body></html>
    `);
  } catch (error) {
    res.status(500).send('Erreur');
  }
});

// ─── POST /newsletter/subscribe ───

router.post('/subscribe', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email requis' });

    const [existing] = await pool.query(
      'SELECT * FROM newsletter_subscribers WHERE email = ?',
      [email]
    );

    if (Array.isArray(existing) && existing.length > 0) {
      const sub = (existing as any[])[0];
      if (sub.unsubscribed_at) {
        await pool.query(
          'UPDATE newsletter_subscribers SET unsubscribed_at = NULL, subscribed_at = NOW() WHERE email = ?',
          [email]
        );
        return res.json({ message: 'Réabonné avec succès' });
      }
      return res.status(409).json({ error: 'Déjà abonné' });
    }

    const id = require('uuid').v4();
    await pool.query(
      'INSERT INTO newsletter_subscribers (id, email) VALUES (?, ?)',
      [id, email]
    );
    res.status(201).json({ message: 'Abonné avec succès' });
  } catch (error) {
    console.error('Subscribe error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── POST /newsletter/unsubscribe ───

router.post('/unsubscribe', async (req, res) => {
  try {
    const { email } = req.body;
    await pool.query(
      'UPDATE newsletter_subscribers SET unsubscribed_at = NOW() WHERE email = ?',
      [email]
    );
    res.json({ message: 'Désabonné avec succès' });
  } catch (error) {
    console.error('Unsubscribe error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── HTML Builder ───

interface NewsletterContent {
  siteName: string;
  siteUrl: string;
  primaryColor: string;
  subject: string;
  introText: string;
  articles: any[];
  events: any[];
  projects: any[];
}

function buildNewsletterHtml(data: NewsletterContent): string {
  const { siteName, siteUrl, primaryColor, introText, articles, events, projects } = data;

  const monthNames = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
  const now = new Date();
  const monthLabel = `${monthNames[now.getMonth()]} ${now.getFullYear()}`;

  function itemCard(item: any, type: string): string {
    const slug = item.slug || item.id;
    const urlMap: Record<string, string> = { article: 'actualites', event: 'evenements', project: 'projets' };
    const link = siteUrl ? `${siteUrl}/${urlMap[type]}/${slug}` : '#';
    const desc = item.excerpt || item.description || '';
    const truncDesc = desc.length > 120 ? desc.substring(0, 120) + '...' : desc;
    const dateStr = item.event_date
      ? new Date(item.event_date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })
      : new Date(item.created_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });

    return `
      <tr><td style="padding: 8px 0;">
        <table width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
          ${item.image_url ? `<tr><td>
            <a href="${link}" style="text-decoration:none;">
              <img src="${siteUrl}${item.image_url}" alt="${item.title}" style="width:100%;max-height:180px;object-fit:cover;display:block;" />
            </a>
          </td></tr>` : ''}
          <tr><td style="padding: 16px;">
            <a href="${link}" style="text-decoration:none;color:${primaryColor};font-size:16px;font-weight:bold;">${item.title}</a>
            <p style="color:#6b7280;font-size:12px;margin:4px 0 8px;">${dateStr}${item.location ? ` · 📍 ${item.location}` : ''}${item.status ? ` · ${item.status}` : ''}</p>
            ${truncDesc ? `<p style="color:#374151;font-size:14px;margin:0 0 12px;line-height:1.5;">${truncDesc}</p>` : ''}
            <a href="${link}" style="display:inline-block;background:${primaryColor};color:#fff;padding:8px 16px;border-radius:6px;text-decoration:none;font-size:13px;">Lire la suite →</a>
          </td></tr>
        </table>
      </td></tr>`;
  }

  function section(title: string, items: any[], type: string): string {
    if (!items || items.length === 0) return '';
    return `
      <tr><td style="padding: 20px 0 8px;">
        <h2 style="color:${primaryColor};font-size:20px;margin:0;border-bottom:2px solid ${primaryColor};padding-bottom:8px;">${title}</h2>
      </td></tr>
      ${items.map(i => itemCard(i, type)).join('')}
    `;
  }

  return `
<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:20px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

        <!-- Header -->
        <tr><td style="background:${primaryColor};padding:30px 24px;text-align:center;">
          <h1 style="color:#ffffff;font-size:26px;margin:0;">${siteName}</h1>
          <p style="color:rgba(255,255,255,0.85);font-size:14px;margin:6px 0 0;">Newsletter — ${monthLabel}</p>
        </td></tr>

        <!-- Intro -->
        ${introText ? `<tr><td style="padding:24px 24px 0;">
          <p style="font-size:15px;color:#374151;line-height:1.6;margin:0;white-space:pre-wrap;">${introText}</p>
        </td></tr>` : ''}

        <!-- Content -->
        <tr><td style="padding:0 24px 24px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            ${section('📰 Actualités', articles, 'article')}
            ${section('📅 Événements', events, 'event')}
            ${section('🌱 Projets', projects, 'project')}
          </table>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#f9fafb;padding:20px 24px;text-align:center;border-top:1px solid #e5e7eb;">
          <p style="color:#9ca3af;font-size:12px;margin:0;">
            Vous recevez cet email car vous êtes abonné(e) à la newsletter de ${siteName}.<br/>
            <a href="${siteUrl}/api/newsletter/unsubscribe-link?email={{EMAIL}}" style="color:${primaryColor};text-decoration:underline;">Se désabonner</a>
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`;
}

export default router;
