import { Router } from 'express';
import nodemailer from 'nodemailer';
import pool from '../db/connection';
import { authenticate, requireAdmin } from '../middleware/auth';
import { decryptSettings } from '../utils/crypto';

const router = Router();

// ─── Helper: get email settings ───

async function getEmailSettings(): Promise<Record<string, string>> {
  const [rows] = await pool.query(
    "SELECT setting_key, setting_value FROM site_settings WHERE category = 'emails'"
  );
  const settings: Record<string, string> = {};
  for (const row of rows as any[]) {
    settings[row.setting_key] = row.setting_value || '';
  }
  return decryptSettings(settings);
}

// ─── Helper: get site name for email template ───

async function getSiteName(): Promise<string> {
  const [rows] = await pool.query(
    "SELECT setting_value FROM site_settings WHERE setting_key = 'site_name' LIMIT 1"
  ) as any[];
  return rows[0]?.setting_value || 'Site Web';
}

// ─── Helper: create nodemailer transporter from settings ───

function createTransporter(settings: Record<string, string>) {
  const host = settings.email_smtp_host;
  const port = parseInt(settings.email_smtp_port || '587');
  const secure = settings.email_smtp_secure === 'true';
  const user = settings.email_smtp_user;
  const pass = settings.email_smtp_pass;

  if (!host || !user || !pass) return null;

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    tls: {
      rejectUnauthorized: false,
    },
  });
}

// ─── Helper: build contact email HTML ───

function buildContactHtml(
  siteName: string,
  primaryColor: string,
  contact: { name: string; email: string; subject?: string; message: string }
): string {
  return `
    <div style="font-family: Arial, sans-serif; background-color: #f9f9f9; padding: 20px 0;">
      <div style="max-width: 600px; margin: auto; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 6px rgba(0,0,0,0.1); background-color: #ffffff;">
        <div style="background: ${primaryColor}; padding: 30px 20px; text-align: center;">
          <h1 style="color: #ffffff; font-size: 24px; margin: 0;">${siteName}</h1>
          <p style="color: rgba(255,255,255,0.8); margin: 5px 0 0; font-size: 14px;">Nouveau message de contact</p>
        </div>
        <div style="padding: 30px 20px;">
          <h2 style="color: ${primaryColor}; font-size: 20px; margin-bottom: 20px; text-align: center;">
            ${contact.subject || `Message de ${contact.name}`}
          </h2>
          <div style="margin-top: 15px; padding: 15px; background-color: #f5f5f5; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
            <p style="margin: 5px 0;"><strong>Nom :</strong> ${contact.name}</p>
            <p style="margin: 5px 0;"><strong>Email :</strong> <a href="mailto:${contact.email}" style="color: ${primaryColor};">${contact.email}</a></p>
            ${contact.subject ? `<p style="margin: 5px 0;"><strong>Sujet :</strong> ${contact.subject}</p>` : ''}
          </div>
          <div style="margin-top: 20px; padding: 20px; background-color: #f0fdf4; border-left: 4px solid ${primaryColor}; border-radius: 4px;">
            <p style="margin: 0; white-space: pre-wrap; line-height: 1.6; color: #333;">${contact.message}</p>
          </div>
        </div>
        <div style="background-color: #f5f5f5; padding: 15px; text-align: center; font-size: 12px; color: #999;">
          <p style="margin: 0;">Ce message a été envoyé via le formulaire de contact de ${siteName}.</p>
        </div>
      </div>
    </div>
  `;
}

// ─── Helper: send email via nodemailer ───

async function sendContactEmail(
  settings: Record<string, string>,
  contact: { name: string; email: string; subject?: string; message: string }
): Promise<boolean> {
  const provider = settings.email_provider;
  if (!provider || provider === 'none') return false;

  if (provider !== 'nodemailer') {
    console.warn(`⚠️ Fournisseur email inconnu : ${provider}`);
    return false;
  }

  const fromName = settings.email_from_name || 'Site Web';
  const fromEmail = settings.email_smtp_user; // send from the SMTP user
  const recipient = settings.email_contact_recipient;

  if (!recipient) {
    console.warn('⚠️ Aucun destinataire de contact configuré');
    return false;
  }

  const transporter = createTransporter(settings);
  if (!transporter) {
    console.warn('⚠️ Configuration SMTP incomplète');
    return false;
  }

  // Get site name + primary color for template
  const siteName = await getSiteName();
  const [colorRows] = await pool.query(
    "SELECT setting_value FROM site_settings WHERE setting_key = 'primary_color' LIMIT 1"
  ) as any[];
  const primaryColor = colorRows[0]?.setting_value || '#166534';

  const htmlBody = buildContactHtml(siteName, primaryColor, contact);

  try {
    await transporter.sendMail({
      from: `${fromName} <${fromEmail}>`,
      to: recipient,
      replyTo: `${contact.name} <${contact.email}>`,
      subject: contact.subject
        ? `[Contact] ${contact.subject}`
        : `[Contact] Message de ${contact.name}`,
      text: `Nom: ${contact.name}\nEmail: ${contact.email}\n${contact.subject ? `Sujet: ${contact.subject}\n` : ''}Message:\n${contact.message}`,
      html: htmlBody,
    });
    console.log(`✅ Email de contact envoyé via Nodemailer à ${recipient}`);
    return true;
  } catch (err) {
    console.error('Erreur envoi email:', err);
    return false;
  }
}

// ─── Routes ───

router.get('/', authenticate, requireAdmin, async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM contact_messages ORDER BY created_at DESC');
    res.json(rows);
  } catch (error) {
    console.error('Get contacts error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, email, subject, message } = req.body;
    if (!name || !email || !message) {
      return res.status(400).json({ error: 'Nom, email et message requis' });
    }
    const id = require('uuid').v4();

    // Always store in DB
    await pool.query(
      'INSERT INTO contact_messages (id, name, email, subject, message) VALUES (?, ?, ?, ?, ?)',
      [id, name, email, subject || null, message]
    );

    // Try to send email if nodemailer is configured
    const settings = await getEmailSettings();
    const emailSent = await sendContactEmail(settings, { name, email, subject, message });

    // Mark as emailed if sent successfully
    if (emailSent) {
      await pool.query('UPDATE contact_messages SET emailed = true WHERE id = ?', [id]);
    }

    res.status(201).json({ message: 'Message envoyé', emailSent });
  } catch (error) {
    console.error('Create contact error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.put('/:id/read', authenticate, requireAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE contact_messages SET `read` = true WHERE id = ?', [req.params.id]);
    res.json({ message: 'Marqué comme lu' });
  } catch (error) {
    console.error('Mark read error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.delete('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM contact_messages WHERE id = ?', [req.params.id]);
    res.json({ message: 'Message supprimé' });
  } catch (error) {
    console.error('Delete contact error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

export default router;
