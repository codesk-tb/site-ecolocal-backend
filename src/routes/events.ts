import { Router } from 'express';
import nodemailer from 'nodemailer';
import pool from '../db/connection';
import { authenticate, requireAdmin, optionalAuth } from '../middleware/auth';
import { decryptSettings } from '../utils/crypto';

const router = Router();

// ─── Helpers: email confirmation ───

async function getEmailSettings(): Promise<Record<string, string>> {
  const [rows] = await pool.query(
    "SELECT setting_key, setting_value FROM site_settings WHERE category IN ('emails', 'general')"
  );
  const settings: Record<string, string> = {};
  for (const row of rows as any[]) {
    settings[row.setting_key] = row.setting_value;
  }
  return decryptSettings(settings);
}

function createTransporter(settings: Record<string, string>) {
  const host = settings.email_smtp_host;
  const port = parseInt(settings.email_smtp_port || '587');
  const secure = settings.email_smtp_secure === 'true';
  const user = settings.email_smtp_user;
  const pass = settings.email_smtp_pass;
  if (!host || !user || !pass) return null;
  return nodemailer.createTransport({ host, port, secure, auth: { user, pass }, tls: { rejectUnauthorized: false } });
}

async function getEventEmailSettings(): Promise<Record<string, string>> {
  const [rows] = await pool.query(
    "SELECT setting_key, setting_value FROM site_settings WHERE setting_key LIKE 'event_email_%'"
  );
  const settings: Record<string, string> = {};
  for (const row of rows as any[]) {
    settings[row.setting_key] = row.setting_value;
  }
  return settings;
}

async function sendRegistrationConfirmation(
  userEmail: string,
  userName: string,
  event: { title: string; event_date: string; start_time: string; location: string; address?: string }
) {
  try {
    const settings = await getEmailSettings();
    if (!settings.email_provider || settings.email_provider === 'none') return;

    // Check if event confirmation email is enabled
    const eventSettings = await getEventEmailSettings();
    if (eventSettings.event_email_enabled === 'false') return;

    const transporter = createTransporter(settings);
    if (!transporter) return;

    const fromName = settings.email_from_name || 'Ecolocal';
    const fromEmail = settings.email_smtp_user;
    const siteName = settings.site_name || 'Ecolocal';
    const primaryColor = eventSettings.event_email_color || '#166534';

    const eventDate = new Date(event.event_date).toLocaleDateString('fr-FR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const eventTime = event.start_time?.slice(0, 5) || '';

    // Configurable subject
    const subjectTemplate = eventSettings.event_email_subject || 'Inscription confirmée — {{EVENT}}';
    const mailSubject = subjectTemplate.replace('{{EVENT}}', event.title);

    // Configurable intro and footer
    const introText = (eventSettings.event_email_intro || 'Votre inscription à l\'événement suivant est confirmée :')
      .replace('{{NAME}}', userName).replace('{{EVENT}}', event.title);
    const footerText = (eventSettings.event_email_footer || 'Nous avons hâte de vous y retrouver !')
      .replace('{{NAME}}', userName).replace('{{EVENT}}', event.title);

    const html = `
      <div style="font-family: Arial, sans-serif; background-color: #f9f9f9; padding: 20px 0;">
        <div style="max-width: 600px; margin: auto; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 6px rgba(0,0,0,0.1); background: #fff;">
          <div style="background: ${primaryColor}; padding: 30px 20px; text-align: center;">
            <h1 style="color: #fff; font-size: 24px; margin: 0;">${siteName}</h1>
            <p style="color: rgba(255,255,255,0.8); margin: 5px 0 0; font-size: 14px;">Confirmation d'inscription</p>
          </div>
          <div style="padding: 30px 20px;">
            <p style="font-size: 16px; color: #333;">Bonjour <strong>${userName}</strong>,</p>
            <p style="font-size: 16px; color: #333;">${introText}</p>
            <div style="margin: 20px 0; padding: 20px; background: #f0fdf4; border-left: 4px solid ${primaryColor}; border-radius: 4px;">
              <h2 style="color: ${primaryColor}; margin: 0 0 10px;">${event.title}</h2>
              <p style="margin: 5px 0; color: #555;">📅 ${eventDate} à ${eventTime}</p>
              <p style="margin: 5px 0; color: #555;">📍 ${event.location}${event.address ? ' — ' + event.address : ''}</p>
            </div>
            <p style="font-size: 14px; color: #666;">${footerText}</p>
          </div>
          <div style="background: #f5f5f5; padding: 15px; text-align: center; font-size: 12px; color: #999;">
            <p style="margin: 0;">Cet email a été envoyé automatiquement par ${siteName}.</p>
          </div>
        </div>
      </div>
    `;

    await transporter.sendMail({
      from: `${fromName} <${fromEmail}>`,
      to: userEmail,
      subject: mailSubject,
      html,
    });
    console.log(`✅ Email de confirmation envoyé à ${userEmail} pour l'événement "${event.title}"`);
  } catch (err) {
    console.error('Erreur envoi email confirmation inscription:', err);
  }
}

// GET /api/events
router.get('/', async (req, res) => {
  try {
    const { upcoming, past, search, page = '1', limit = '12', published } = req.query;
    const offset = (Number(page) - 1) * Number(limit);
    const params: any[] = [];
    const conditions: string[] = [];

    if (published !== 'all') {
      conditions.push('published = true');
    }
    if (upcoming === 'true') {
      conditions.push('event_date >= CURDATE()');
    }
    if (past === 'true') {
      conditions.push('event_date < CURDATE()');
    }
    if (search) {
      conditions.push('(title LIKE ? OR description LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }

    let where = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';

    const [countRows] = await pool.query('SELECT COUNT(*) as total FROM events' + where, params);
    const total = (countRows as any[])[0]?.total || 0;

    const [rows] = await pool.query(
      `SELECT e.*, 
       (SELECT COUNT(*) FROM event_registrations WHERE event_id = e.id AND status = 'confirmed') as registration_count
       FROM events e` + where + ' ORDER BY e.event_date ASC LIMIT ? OFFSET ?',
      [...params, Number(limit), offset]
    );

    res.json({ data: rows, total, page: Number(page), limit: Number(limit) });
  } catch (error) {
    console.error('Get events error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/events/:slug
router.get('/:slug', optionalAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT e.*,
       (SELECT COUNT(*) FROM event_registrations WHERE event_id = e.id AND status = 'confirmed') as registration_count
       FROM events e WHERE e.slug = ?`,
      [req.params.slug]
    );
    const events = rows as any[];
    
    if (events.length === 0) {
      return res.status(404).json({ error: 'Événement non trouvé' });
    }

    const event = events[0];
    let isRegistered = false;

    if (req.user) {
      const [regRows] = await pool.query(
        'SELECT id FROM event_registrations WHERE event_id = ? AND user_id = ?',
        [event.id, req.user.id]
      );
      isRegistered = Array.isArray(regRows) && regRows.length > 0;
    }

    res.json({ ...event, isRegistered });
  } catch (error) {
    console.error('Get event error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/events — admin only
router.post('/', authenticate, requireAdmin, async (req, res) => {
  try {
    const { title, slug, description, content, image_url, event_date, start_time, end_time, location, address, max_participants, registration_required, registration_deadline, published } = req.body;
    const id = require('uuid').v4();
    
    await pool.query(
      `INSERT INTO events (id, title, slug, description, content, image_url, event_date, start_time, end_time, location, address, max_participants, registration_required, registration_deadline, published)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, title, slug, description || null, content || null, image_url || null, event_date, start_time || null, end_time || null, location || null, address || null, max_participants || null, registration_required ?? false, registration_deadline || null, published ?? false]
    );

    const [rows] = await pool.query('SELECT * FROM events WHERE id = ?', [id]);
    res.status(201).json((rows as any[])[0]);
  } catch (error) {
    console.error('Create event error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/events/:id
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
      event_date: v => v,
      start_time: v => v || null,
      end_time: v => v || null,
      location: v => v || null,
      address: v => v || null,
      max_participants: v => v || null,
      registration_required: v => v ?? false,
      registration_deadline: v => v || null,
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
      `UPDATE events SET ${fields.join(', ')} WHERE id = ?`,
      params
    );

    const [rows] = await pool.query('SELECT * FROM events WHERE id = ?', [req.params.id]);
    res.json((rows as any[])[0]);
  } catch (error) {
    console.error('Update event error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /api/events/:id
router.delete('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM events WHERE id = ?', [req.params.id]);
    res.json({ message: 'Événement supprimé' });
  } catch (error) {
    console.error('Delete event error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/events/:id/register — user registration
router.post('/:id/register', authenticate, async (req, res) => {
  try {
    const eventId = req.params.id;

    // Check event exists and has room
    const [eventRows] = await pool.query('SELECT * FROM events WHERE id = ?', [eventId]);
    const events = eventRows as any[];
    if (events.length === 0) {
      return res.status(404).json({ error: 'Événement non trouvé' });
    }

    const event = events[0];
    if (event.max_participants) {
      const [regCount] = await pool.query(
        "SELECT COUNT(*) as count FROM event_registrations WHERE event_id = ? AND status = 'confirmed'",
        [eventId]
      );
      if ((regCount as any[])[0].count >= event.max_participants) {
        return res.status(400).json({ error: 'Complet' });
      }
    }

    // Check if already registered
    const [existing] = await pool.query(
      'SELECT id FROM event_registrations WHERE event_id = ? AND user_id = ?',
      [eventId, req.user!.id]
    );
    if (Array.isArray(existing) && existing.length > 0) {
      return res.status(400).json({ error: 'Déjà inscrit' });
    }

    const id = require('uuid').v4();
    await pool.query(
      "INSERT INTO event_registrations (id, event_id, user_id, status) VALUES (?, ?, ?, 'confirmed')",
      [id, eventId, req.user!.id]
    );

    // Send confirmation email (non-blocking)
    const [userRows] = await pool.query('SELECT email, full_name, first_name, last_name FROM users WHERE id = ?', [req.user!.id]);
    const user = (userRows as any[])[0];
    if (user?.email) {
      const userName = user.full_name || [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Membre';
      sendRegistrationConfirmation(user.email, userName, {
        title: event.title,
        event_date: event.event_date,
        start_time: event.start_time,
        location: event.location || '',
        address: event.address || '',
      }).catch(() => {});
    }

    res.status(201).json({ message: 'Inscription confirmée' });
  } catch (error) {
    console.error('Register event error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /api/events/:id/register — cancel registration
router.delete('/:id/register', authenticate, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM event_registrations WHERE event_id = ? AND user_id = ?',
      [req.params.id, req.user!.id]
    );
    res.json({ message: 'Inscription annulée' });
  } catch (error) {
    console.error('Cancel registration error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/events/:id/registrations — admin
router.get('/:id/registrations', authenticate, requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT er.*, u.email, u.full_name, u.first_name, u.last_name
       FROM event_registrations er
       LEFT JOIN users u ON er.user_id = u.id
       WHERE er.event_id = ?
       ORDER BY er.created_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (error) {
    console.error('Get registrations error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

export default router;
