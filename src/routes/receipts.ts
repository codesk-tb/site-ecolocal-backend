import { Router, Response } from 'express';
import PDFDocument from 'pdfkit';
import pool from '../db/connection';
import { authenticate, requireAdmin } from '../middleware/auth';

const router = Router();

// ─── Helpers ───

async function getReceiptSettings(): Promise<Record<string, string>> {
  const [rows] = await pool.query(
    "SELECT setting_key, setting_value FROM site_settings WHERE category = 'receipt'"
  );
  const settings: Record<string, string> = {};
  for (const row of rows as any[]) {
    settings[row.setting_key] = row.setting_value || '';
  }
  return settings;
}

function hexToRGB(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.substring(0, 2), 16) || 0,
    parseInt(h.substring(2, 4), 16) || 0,
    parseInt(h.substring(4, 6), 16) || 0,
  ];
}

// Generate unique receipt number
function generateReceiptNumber(type: 'DON' | 'ADH', date: Date, index: number): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${type}-${y}${m}${d}-${String(index).padStart(4, '0')}`;
}

// ─── Generate PDF receipt ───

function buildReceiptPDF(
  res: Response,
  settings: Record<string, string>,
  data: {
    type: 'donation' | 'membership';
    receiptNumber: string;
    date: string;
    amount: number;
    currency: string;
    userName: string;
    userEmail: string;
    paymentMethod: string;
    description: string;
    isRecurring?: boolean;
    membershipType?: string;
    startDate?: string;
    endDate?: string;
  }
) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="recu-${data.receiptNumber}.pdf"`);
  doc.pipe(res);

  const primaryColor = hexToRGB(settings.receipt_primary_color || '#166534');
  const secondaryColor = hexToRGB(settings.receipt_secondary_color || '#15803d');
  const orgName = settings.receipt_org_name || 'Association Ecolocal';
  const orgAddress = settings.receipt_org_address || '';
  const orgPhone = settings.receipt_org_phone || '';
  const orgEmail = settings.receipt_org_email || '';
  const orgSiret = settings.receipt_org_siret || '';
  const orgRNA = settings.receipt_org_rna || '';
  const orgLogo = settings.receipt_logo_url || '';
  const footerText = settings.receipt_footer_text || "Ce reçu est délivré en vertu de l'article 200 du Code Général des Impôts. Il atteste du versement d'un don au profit de l'association et ouvre droit à une réduction d'impôt.";
  const showTaxInfo = settings.receipt_show_tax_info !== 'false';
  const titleText = data.type === 'donation'
    ? (settings.receipt_donation_title || 'Reçu de don')
    : (settings.receipt_membership_title || "Reçu d'adhésion");

  const pageWidth = doc.page.width - 100; // margins

  // ─── Header bar ───
  doc.rect(0, 0, doc.page.width, 8).fill(primaryColor);

  // ─── Organization info (top-left) ───
  let y = 30;

  doc.fontSize(18).fillColor(primaryColor).font('Helvetica-Bold').text(orgName, 50, y);
  y += 28;
  doc.fontSize(9).fillColor('#555555').font('Helvetica');
  if (orgAddress) { doc.text(orgAddress, 50, y); y += 14; }
  if (orgPhone) { doc.text(`Tél: ${orgPhone}`, 50, y); y += 14; }
  if (orgEmail) { doc.text(`Email: ${orgEmail}`, 50, y); y += 14; }
  if (orgSiret) { doc.text(`SIRET: ${orgSiret}`, 50, y); y += 14; }
  if (orgRNA) { doc.text(`RNA: ${orgRNA}`, 50, y); y += 14; }

  // ─── Receipt title ───
  y = Math.max(y + 20, 140);
  doc.rect(50, y, pageWidth, 40).fill(primaryColor);
  doc.fontSize(16).fillColor('#ffffff').font('Helvetica-Bold')
    .text(titleText.toUpperCase(), 50, y + 12, { width: pageWidth, align: 'center' });
  y += 60;

  // ─── Receipt number + date ───
  doc.fontSize(10).fillColor('#333333').font('Helvetica');
  doc.text(`N° de reçu : `, 50, y, { continued: true }).font('Helvetica-Bold').text(data.receiptNumber);
  y += 18;
  doc.font('Helvetica').text(`Date : `, 50, y, { continued: true }).font('Helvetica-Bold').text(data.date);
  y += 30;

  // ─── Separator ───
  doc.moveTo(50, y).lineTo(50 + pageWidth, y).strokeColor('#dddddd').lineWidth(1).stroke();
  y += 20;

  // ─── Donor / Member info ───
  doc.fontSize(12).fillColor(secondaryColor).font('Helvetica-Bold').text('Informations du bénéficiaire', 50, y);
  y += 22;
  doc.fontSize(10).fillColor('#333333').font('Helvetica');
  doc.text(`Nom : ${data.userName}`, 70, y); y += 16;
  doc.text(`Email : ${data.userEmail}`, 70, y); y += 25;

  // ─── Payment details ───
  doc.fontSize(12).fillColor(secondaryColor).font('Helvetica-Bold').text('Détails du paiement', 50, y);
  y += 22;

  // Table-like display
  const labelX = 70;
  const valueX = 250;
  doc.fontSize(10).fillColor('#555555').font('Helvetica');

  const rows: [string, string][] = [
    ['Description', data.description],
    ['Montant', `${new Intl.NumberFormat('fr-FR', { style: 'currency', currency: data.currency || 'EUR' }).format(data.amount)}`],
    ['Mode de paiement', data.paymentMethod],
  ];

  if (data.isRecurring) {
    rows.push(['Type', 'Récurrent (mensuel)']);
  }
  if (data.membershipType) {
    rows.push(['Type d\'adhésion', data.membershipType]);
  }
  if (data.startDate) {
    rows.push(['Date de début', data.startDate]);
  }
  if (data.endDate) {
    rows.push(['Date de fin', data.endDate]);
  }

  for (const [label, value] of rows) {
    // Alternate row background
    const rowIndex = rows.indexOf([label, value]);
    doc.fillColor('#555555').text(label, labelX, y);
    doc.fillColor('#111111').font('Helvetica-Bold').text(value, valueX, y);
    doc.font('Helvetica');
    y += 20;
  }

  // ─── Amount highlight box ───
  y += 10;
  doc.rect(50, y, pageWidth, 50).fill('#f0fdf4');
  doc.rect(50, y, 4, 50).fill(primaryColor);
  doc.fontSize(14).fillColor(primaryColor).font('Helvetica-Bold')
    .text(`Montant total : ${new Intl.NumberFormat('fr-FR', { style: 'currency', currency: data.currency || 'EUR' }).format(data.amount)}`, 70, y + 16, { width: pageWidth - 40 });
  y += 70;

  // ─── Tax deduction info ───
  if (showTaxInfo && data.type === 'donation') {
    doc.rect(50, y, pageWidth, 60).fill('#eff6ff');
    doc.rect(50, y, 4, 60).fill('#3b82f6');
    doc.fontSize(9).fillColor('#1e40af').font('Helvetica-Bold')
      .text('Information fiscale', 70, y + 10);
    doc.font('Helvetica').fontSize(8).fillColor('#1e3a5f')
      .text(
        "Conformément à l'article 200 du CGI, ce don ouvre droit à une réduction d'impôt sur le revenu de 66% du montant versé, dans la limite de 20% du revenu imposable.",
        70, y + 26, { width: pageWidth - 40 }
      );
    y += 75;
  }

  // ─── Footer ───
  y = doc.page.height - 120;
  doc.moveTo(50, y).lineTo(50 + pageWidth, y).strokeColor('#dddddd').lineWidth(0.5).stroke();
  y += 10;
  doc.fontSize(7).fillColor('#999999').font('Helvetica')
    .text(footerText, 50, y, { width: pageWidth, align: 'center' });

  // Bottom bar
  doc.rect(0, doc.page.height - 8, doc.page.width, 8).fill(primaryColor);

  doc.end();
}

// ─── GET /api/receipts/settings — Get receipt template settings ───

router.get('/settings', authenticate, requireAdmin, async (_req, res) => {
  try {
    const settings = await getReceiptSettings();
    res.json(settings);
  } catch (error) {
    console.error('Get receipt settings error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── PUT /api/receipts/settings — Update receipt template settings ───

router.put('/settings', authenticate, requireAdmin, async (req, res) => {
  try {
    const { settings } = req.body;
    if (!settings || typeof settings !== 'object') {
      return res.status(400).json({ error: 'Settings manquants' });
    }
    for (const [key, value] of Object.entries(settings)) {
      const settingKey = key.startsWith('receipt_') ? key : `receipt_${key}`;
      await pool.query(
        `INSERT INTO site_settings (id, setting_key, setting_value, setting_type, label, category, display_order)
         VALUES (UUID(), ?, ?, 'text', ?, 'receipt', 100)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
        [settingKey, value, settingKey]
      );
    }
    const updated = await getReceiptSettings();
    res.json(updated);
  } catch (error) {
    console.error('Update receipt settings error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── GET /api/receipts/preview — Admin PDF preview ───

router.get('/preview', authenticate, requireAdmin, async (_req, res) => {
  try {
    const settings = await getReceiptSettings();
    buildReceiptPDF(res, settings, {
      type: 'donation',
      receiptNumber: 'DON-20260101-0001',
      date: new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }),
      amount: 50,
      currency: 'EUR',
      userName: 'Jean Dupont',
      userEmail: 'jean.dupont@email.com',
      paymentMethod: 'Carte bancaire (Stripe)',
      description: 'Don ponctuel pour soutenir l\'association',
    });
  } catch (error) {
    console.error('Preview receipt error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── GET /api/receipts/preview/membership — Admin membership PDF preview ───

router.get('/preview/membership', authenticate, requireAdmin, async (_req, res) => {
  try {
    const settings = await getReceiptSettings();
    buildReceiptPDF(res, settings, {
      type: 'membership',
      receiptNumber: 'ADH-20260101-0001',
      date: new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }),
      amount: 20,
      currency: 'EUR',
      userName: 'Marie Martin',
      userEmail: 'marie.martin@email.com',
      paymentMethod: 'Carte bancaire (Stripe)',
      description: 'Adhésion annuelle',
      membershipType: 'Standard',
      startDate: new Date().toLocaleDateString('fr-FR'),
      endDate: new Date(Date.now() + 365 * 86400000).toLocaleDateString('fr-FR'),
    });
  } catch (error) {
    console.error('Preview membership receipt error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── GET /api/receipts/donation/:id — Download donation receipt ───

router.get('/donation/:id', authenticate, async (req, res) => {
  try {
    const userId = req.user!.id;
    const isAdmin = req.user!.role === 'admin';

    const [rows] = await pool.query(
      `SELECT d.*, u.full_name, u.email as user_email FROM donations d
       LEFT JOIN users u ON d.user_id = u.id WHERE d.id = ?`,
      [req.params.id]
    );
    const donation = (rows as any[])[0];
    if (!donation) return res.status(404).json({ error: 'Don introuvable' });
    if (!isAdmin && donation.user_id !== userId) return res.status(403).json({ error: 'Accès interdit' });

    const settings = await getReceiptSettings();

    // Count donations before this one for receipt numbering
    const [countRows] = await pool.query(
      "SELECT COUNT(*) as cnt FROM donations WHERE created_at <= ? AND status = 'completed'",
      [donation.created_at]
    );
    const index = ((countRows as any[])[0]?.cnt || 1);

    const createdDate = new Date(donation.created_at);
    buildReceiptPDF(res, settings, {
      type: 'donation',
      receiptNumber: generateReceiptNumber('DON', createdDate, index),
      date: createdDate.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }),
      amount: Number(donation.amount) || 0,
      currency: donation.currency || 'EUR',
      userName: donation.donor_name || donation.full_name || 'Donateur',
      userEmail: donation.donor_email || donation.user_email || '',
      paymentMethod: donation.stripe_session_id ? 'Carte bancaire (Stripe)' : 'Autre',
      description: donation.is_recurring ? 'Don récurrent mensuel' : 'Don ponctuel',
      isRecurring: !!donation.is_recurring,
    });
  } catch (error) {
    console.error('Download donation receipt error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── GET /api/receipts/membership/:id — Download membership receipt ───

router.get('/membership/:id', authenticate, async (req, res) => {
  try {
    const userId = req.user!.id;
    const isAdmin = req.user!.role === 'admin';

    const [rows] = await pool.query(
      `SELECT m.*, u.full_name, u.email as user_email FROM memberships m
       LEFT JOIN users u ON m.user_id = u.id WHERE m.id = ?`,
      [req.params.id]
    );
    const membership = (rows as any[])[0];
    if (!membership) return res.status(404).json({ error: 'Adhésion introuvable' });
    if (!isAdmin && membership.user_id !== userId) return res.status(403).json({ error: 'Accès interdit' });

    const settings = await getReceiptSettings();

    const [countRows] = await pool.query(
      "SELECT COUNT(*) as cnt FROM memberships WHERE created_at <= ?",
      [membership.created_at]
    );
    const index = ((countRows as any[])[0]?.cnt || 1);

    const createdDate = new Date(membership.created_at);
    const memberName = [membership.first_name, membership.last_name].filter(Boolean).join(' ') || membership.full_name || 'Adhérent';

    buildReceiptPDF(res, settings, {
      type: 'membership',
      receiptNumber: generateReceiptNumber('ADH', createdDate, index),
      date: createdDate.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }),
      amount: Number(membership.amount) || 0,
      currency: 'EUR',
      userName: memberName,
      userEmail: membership.email || membership.user_email || '',
      paymentMethod: membership.stripe_session_id ? 'Carte bancaire (Stripe)' : 'Autre',
      description: 'Adhésion annuelle',
      membershipType: membership.membership_type || 'Standard',
      startDate: membership.start_date ? new Date(membership.start_date).toLocaleDateString('fr-FR') : undefined,
      endDate: membership.end_date ? new Date(membership.end_date).toLocaleDateString('fr-FR') : undefined,
    });
  } catch (error) {
    console.error('Download membership receipt error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── GET /api/receipts/my — List all user's available receipts ───

router.get('/my', authenticate, async (req, res) => {
  try {
    const userId = req.user!.id;

    const [donations] = await pool.query(
      "SELECT id, amount, currency, status, created_at, is_recurring, donor_name, 'donation' as receipt_type FROM donations WHERE user_id = ? AND status = 'completed' ORDER BY created_at DESC",
      [userId]
    );

    const [memberships] = await pool.query(
      "SELECT id, amount, 'EUR' as currency, status, created_at, membership_type, first_name, last_name, 'membership' as receipt_type FROM memberships WHERE user_id = ? AND (status = 'active' OR status = 'completed') ORDER BY created_at DESC",
      [userId]
    );

    res.json({
      donations: donations as any[],
      memberships: memberships as any[],
    });
  } catch (error) {
    console.error('Get my receipts error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

export default router;
