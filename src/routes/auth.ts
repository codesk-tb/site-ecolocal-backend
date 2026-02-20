import { Router } from 'express';
import bcrypt from 'bcryptjs';
import nodemailer from 'nodemailer';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db/connection';
import { authenticate, generateToken, optionalAuth, requireAdmin } from '../middleware/auth';

const router = Router();

// ─── Helpers ──────────────────────────────────────────────────

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

function generateResetCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Password strength validation
const PASSWORD_REGEX = /^(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;
const PASSWORD_ERROR = 'Le mot de passe doit contenir au moins 8 caractères, une majuscule, un chiffre et un caractère spécial';

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email et mot de passe requis' });
    }
    if (!PASSWORD_REGEX.test(password)) {
      return res.status(400).json({ error: PASSWORD_ERROR });
    }

    // Check existing user
    const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
    if (Array.isArray(existing) && existing.length > 0) {
      return res.status(409).json({ error: 'Un compte existe déjà avec cet email' });
    }

    const id = uuidv4();
    const passwordHash = await bcrypt.hash(password, 12);
    
    await pool.query(
      'INSERT INTO users (id, email, password_hash, email_confirmed_at) VALUES (?, ?, ?, NOW())',
      [id, email, passwordHash]
    );

    const token = generateToken({ id, email });
    
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.status(201).json({ user: { id, email }, token });
  } catch (error: any) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email et mot de passe requis' });
    }

    const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
    const users = rows as any[];
    
    if (users.length === 0) {
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }

    const user = users[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);
    
    if (!validPassword) {
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }

    // Check admin role
    const [roleRows] = await pool.query(
      'SELECT role FROM user_roles WHERE user_id = ? AND role = ?',
      [user.id, 'admin']
    );
    const isAdmin = Array.isArray(roleRows) && roleRows.length > 0;

    // ─── 2FA check ────────────────────────────────────────────
    const [twoFaSettingRows] = await pool.query(
      "SELECT setting_value FROM site_settings WHERE setting_key = '2fa_enabled' LIMIT 1"
    );
    const globalTwoFa = Array.isArray(twoFaSettingRows) && (twoFaSettingRows as any[])[0]?.setting_value === 'true';
    const userTwoFa = user.two_factor_enabled !== 0; // default true

    if (globalTwoFa && userTwoFa) {
      // Generate and send 2FA code
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

      // Delete any existing codes for this user
      await pool.query('DELETE FROM two_factor_codes WHERE user_id = ?', [user.id]);

      const codeHash = await bcrypt.hash(code, 10);
      await pool.query(
        'INSERT INTO two_factor_codes (id, user_id, code_hash, expires_at) VALUES (?, ?, ?, ?)',
        [uuidv4(), user.id, codeHash, expiresAt]
      );

      // Try to send email
      const emailSettings = await getEmailSettings();
      if (emailSettings.email_provider === 'nodemailer' && emailSettings.email_smtp_host) {
        try {
          const transporter = nodemailer.createTransport({
            host: emailSettings.email_smtp_host,
            port: parseInt(emailSettings.email_smtp_port || '587'),
            secure: emailSettings.email_smtp_secure === 'true',
            auth: {
              user: emailSettings.email_smtp_user,
              pass: emailSettings.email_smtp_pass,
            },
            tls: { rejectUnauthorized: false },
          });

          const [siteRows] = await pool.query(
            "SELECT setting_value FROM site_settings WHERE setting_key = 'site_name' LIMIT 1"
          ) as any[];
          const siteName = siteRows[0]?.setting_value || 'Site Web';
          const fromName = emailSettings.email_from_name || siteName;
          const fromEmail = emailSettings.email_smtp_user;

          await transporter.sendMail({
            from: `${fromName} <${fromEmail}>`,
            to: user.email,
            subject: `${siteName} — Code de vérification`,
            html: `
              <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:20px">
                <h2 style="color:#333;text-align:center">${siteName}</h2>
                <p>Bonjour${user.first_name ? ' ' + user.first_name : ''},</p>
                <p>Voici votre code de vérification pour vous connecter :</p>
                <div style="text-align:center;margin:30px 0">
                  <span style="font-size:32px;font-weight:bold;letter-spacing:8px;background:#f3f4f6;padding:16px 32px;border-radius:8px;display:inline-block">${code}</span>
                </div>
                <p style="color:#666;font-size:14px">Ce code est valable <strong>10 minutes</strong>. Si vous n'avez pas demandé cette connexion, ignorez cet email.</p>
                <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
                <p style="color:#999;font-size:12px;text-align:center">${siteName}</p>
              </div>
            `,
            text: `Votre code de vérification : ${code}\n\nCe code est valable 10 minutes.`,
          });
        } catch (emailErr) {
          console.error('Error sending 2FA email:', emailErr);
        }
      } else {
        console.log(`[2FA Code] ${email}: ${code}`);
      }

      // Return requires2FA without logging in
      return res.json({
        requires2FA: true,
        email: user.email,
        message: 'Un code de vérification a été envoyé à votre adresse email.',
      });
    }

    // ─── No 2FA — normal login ────────────────────────────────
    const token = generateToken({ id: user.id, email: user.email });
    
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.json({
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        first_name: user.first_name,
        last_name: user.last_name,
        phone: user.phone,
        avatar_url: user.avatar_url,
        created_at: user.created_at,
      },
      isAdmin,
      token,
    });
  } catch (error: any) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/auth/logout
router.post('/logout', (_req, res) => {
  res.clearCookie('token');
  res.json({ message: 'Déconnecté' });
});

// POST /api/auth/verify-2fa
router.post('/verify-2fa', async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'Email et code requis' });

    const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
    const users = rows as any[];
    if (users.length === 0) {
      return res.status(401).json({ error: 'Utilisateur non trouvé' });
    }
    const user = users[0];

    // Find valid 2FA code
    const [codeRows] = await pool.query(
      'SELECT * FROM two_factor_codes WHERE user_id = ? AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1',
      [user.id]
    );
    const codes = codeRows as any[];

    if (codes.length === 0) {
      return res.status(400).json({ error: 'Code expiré. Veuillez vous reconnecter.' });
    }

    const valid = await bcrypt.compare(code, codes[0].code_hash);
    if (!valid) {
      return res.status(400).json({ error: 'Code incorrect' });
    }

    // Cleanup used code
    await pool.query('DELETE FROM two_factor_codes WHERE user_id = ?', [user.id]);

    // Check admin role
    const [roleRows] = await pool.query(
      'SELECT role FROM user_roles WHERE user_id = ? AND role = ?',
      [user.id, 'admin']
    );
    const isAdmin = Array.isArray(roleRows) && roleRows.length > 0;

    const token = generateToken({ id: user.id, email: user.email });

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.json({
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        first_name: user.first_name,
        last_name: user.last_name,
        phone: user.phone,
        avatar_url: user.avatar_url,
        created_at: user.created_at,
      },
      isAdmin,
      token,
    });
  } catch (error) {
    console.error('Verify 2FA error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/auth/resend-2fa — resend 2FA code
router.post('/resend-2fa', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email requis' });

    const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
    const users = rows as any[];
    if (users.length === 0) {
      return res.json({ message: 'Code envoyé.' }); // Don't reveal user existence
    }
    const user = users[0];

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await pool.query('DELETE FROM two_factor_codes WHERE user_id = ?', [user.id]);

    const codeHash = await bcrypt.hash(code, 10);
    await pool.query(
      'INSERT INTO two_factor_codes (id, user_id, code_hash, expires_at) VALUES (?, ?, ?, ?)',
      [uuidv4(), user.id, codeHash, expiresAt]
    );

    const emailSettings = await getEmailSettings();
    if (emailSettings.email_provider === 'nodemailer' && emailSettings.email_smtp_host) {
      try {
        const transporter = nodemailer.createTransport({
          host: emailSettings.email_smtp_host,
          port: parseInt(emailSettings.email_smtp_port || '587'),
          secure: emailSettings.email_smtp_secure === 'true',
          auth: {
            user: emailSettings.email_smtp_user,
            pass: emailSettings.email_smtp_pass,
          },
          tls: { rejectUnauthorized: false },
        });

        const [siteRows] = await pool.query(
          "SELECT setting_value FROM site_settings WHERE setting_key = 'site_name' LIMIT 1"
        ) as any[];
        const siteName = siteRows[0]?.setting_value || 'Site Web';
        const fromName = emailSettings.email_from_name || siteName;
        const fromEmail = emailSettings.email_smtp_user;

        await transporter.sendMail({
          from: `${fromName} <${fromEmail}>`,
          to: user.email,
          subject: `${siteName} — Nouveau code de vérification`,
          html: `
            <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:20px">
              <h2 style="color:#333;text-align:center">${siteName}</h2>
              <p>Bonjour${user.first_name ? ' ' + user.first_name : ''},</p>
              <p>Voici votre nouveau code de vérification :</p>
              <div style="text-align:center;margin:30px 0">
                <span style="font-size:32px;font-weight:bold;letter-spacing:8px;background:#f3f4f6;padding:16px 32px;border-radius:8px;display:inline-block">${code}</span>
              </div>
              <p style="color:#666;font-size:14px">Ce code est valable <strong>10 minutes</strong>.</p>
              <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
              <p style="color:#999;font-size:12px;text-align:center">${siteName}</p>
            </div>
          `,
          text: `Votre code de vérification : ${code}\n\nCe code est valable 10 minutes.`,
        });
      } catch (emailErr) {
        console.error('Error sending 2FA email:', emailErr);
      }
    } else {
      console.log(`[2FA Code Resend] ${email}: ${code}`);
    }

    res.json({ message: 'Un nouveau code a été envoyé.' });
  } catch (error) {
    console.error('Resend 2FA error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/auth/toggle-2fa — toggle per-user 2FA
router.put('/toggle-2fa', authenticate, async (req, res) => {
  try {
    const { enabled } = req.body;
    await pool.query('UPDATE users SET two_factor_enabled = ? WHERE id = ?', [enabled ? 1 : 0, req.user!.id]);
    res.json({ message: enabled ? '2FA activée' : '2FA désactivée' });
  } catch (error) {
    console.error('Toggle 2FA error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/auth/admin-profile — get admin's full profile
router.get('/admin-profile', authenticate, requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, email, full_name, first_name, last_name, phone, avatar_url, created_at, two_factor_enabled FROM users WHERE id = ?',
      [req.user!.id]
    );
    const users = rows as any[];
    if (users.length === 0) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }

    // Get total user count and other admin stats
    const [userCount] = await pool.query('SELECT COUNT(*) as total FROM users');
    const [articleCount] = await pool.query('SELECT COUNT(*) as total FROM articles');
    const [donationCount] = await pool.query('SELECT COUNT(*) as total FROM donations WHERE status = ?', ['completed']);

    res.json({
      admin: users[0],
      stats: {
        totalUsers: (userCount as any[])[0]?.total || 0,
        totalArticles: (articleCount as any[])[0]?.total || 0,
        totalDonations: (donationCount as any[])[0]?.total || 0,
      },
    });
  } catch (error) {
    console.error('Get admin profile error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/auth/me
router.get('/me', authenticate, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, email, full_name, first_name, last_name, phone, avatar_url, created_at FROM users WHERE id = ?',
      [req.user!.id]
    );
    const users = rows as any[];
    
    if (users.length === 0) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }

    const [roleRows] = await pool.query(
      'SELECT role FROM user_roles WHERE user_id = ? AND role = ?',
      [req.user!.id, 'admin']
    );
    const isAdmin = Array.isArray(roleRows) && roleRows.length > 0;

    res.json({ user: users[0], isAdmin });
  } catch (error) {
    console.error('Get me error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/auth/update-profile
router.put('/update-profile', authenticate, async (req, res) => {
  try {
    const { first_name, last_name, phone, avatar_url } = req.body;
    
    await pool.query(
      'UPDATE users SET first_name = ?, last_name = ?, phone = ?, avatar_url = ? WHERE id = ?',
      [first_name || null, last_name || null, phone || null, avatar_url || null, req.user!.id]
    );

    res.json({ message: 'Profil mis à jour' });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/auth/update-password
router.put('/update-password', authenticate, async (req, res) => {
  try {
    const { password } = req.body;
    
    if (!password || !PASSWORD_REGEX.test(password)) {
      return res.status(400).json({ error: PASSWORD_ERROR });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, req.user!.id]);

    res.json({ message: 'Mot de passe mis à jour' });
  } catch (error) {
    console.error('Update password error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/auth/update-email
router.put('/update-email', authenticate, async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email requis' });
    }

    const [existing] = await pool.query('SELECT id FROM users WHERE email = ? AND id != ?', [email, req.user!.id]);
    if (Array.isArray(existing) && existing.length > 0) {
      return res.status(409).json({ error: 'Cet email est déjà utilisé' });
    }

    await pool.query('UPDATE users SET email = ? WHERE id = ?', [email, req.user!.id]);

    const token = generateToken({ id: req.user!.id, email });
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.json({ message: 'Email mis à jour', token });
  } catch (error) {
    console.error('Update email error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── Forgot / Reset Password ──────────────────────────────────

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email requis' });

    // Always respond success to prevent email enumeration
    const [rows] = await pool.query('SELECT id, email FROM users WHERE email = ?', [email]);
    const users = rows as any[];

    if (users.length === 0) {
      // Don't reveal that the email doesn't exist
      return res.json({ message: 'Si un compte existe, un code a été envoyé.' });
    }

    const user = users[0];
    const code = generateResetCode();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    // Delete any existing codes for this user
    await pool.query('DELETE FROM password_resets WHERE user_id = ?', [user.id]);

    // Store the code (hashed)
    const codeHash = await bcrypt.hash(code, 10);
    await pool.query(
      'INSERT INTO password_resets (id, user_id, code_hash, expires_at) VALUES (?, ?, ?, ?)',
      [uuidv4(), user.id, codeHash, expiresAt]
    );

    // Try to send email
    const emailSettings = await getEmailSettings();
    if (emailSettings.email_provider === 'nodemailer' && emailSettings.email_smtp_host) {
      try {
        const transporter = nodemailer.createTransport({
          host: emailSettings.email_smtp_host,
          port: parseInt(emailSettings.email_smtp_port || '587'),
          secure: emailSettings.email_smtp_secure === 'true',
          auth: {
            user: emailSettings.email_smtp_user,
            pass: emailSettings.email_smtp_pass,
          },
          tls: { rejectUnauthorized: false },
        });

        const [siteRows] = await pool.query(
          "SELECT setting_value FROM site_settings WHERE setting_key = 'site_name' LIMIT 1"
        ) as any[];
        const siteName = siteRows[0]?.setting_value || 'Site Web';
        const fromName = emailSettings.email_from_name || siteName;
        const fromEmail = emailSettings.email_smtp_user;

        await transporter.sendMail({
          from: `${fromName} <${fromEmail}>`,
          to: user.email,
          subject: `${siteName} — Code de réinitialisation`,
          html: `
            <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:20px">
              <h2 style="color:#333;text-align:center">${siteName}</h2>
              <p>Bonjour,</p>
              <p>Vous avez demandé la réinitialisation de votre mot de passe. Voici votre code :</p>
              <div style="text-align:center;margin:30px 0">
                <span style="font-size:32px;font-weight:bold;letter-spacing:8px;background:#f3f4f6;padding:16px 32px;border-radius:8px;display:inline-block">${code}</span>
              </div>
              <p style="color:#666;font-size:14px">Ce code est valable <strong>15 minutes</strong>. Si vous n'avez pas demandé cette réinitialisation, ignorez cet email.</p>
              <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
              <p style="color:#999;font-size:12px;text-align:center">${siteName}</p>
            </div>
          `,
          text: `Votre code de réinitialisation : ${code}\n\nCe code est valable 15 minutes.`,
        });
      } catch (emailErr) {
        console.error('Error sending reset email:', emailErr);
        // Still return success — the code is in the DB, admin can check
      }
    } else {
      console.log(`[Reset Code] ${email}: ${code}`);
    }

    res.json({ message: 'Si un compte existe, un code a été envoyé.' });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/auth/verify-reset-code
router.post('/verify-reset-code', async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'Email et code requis' });

    const [rows] = await pool.query(
      `SELECT pr.*, u.email FROM password_resets pr
       JOIN users u ON u.id = pr.user_id
       WHERE u.email = ? AND pr.expires_at > NOW()
       ORDER BY pr.expires_at DESC LIMIT 1`,
      [email]
    );
    const resets = rows as any[];

    if (resets.length === 0) {
      return res.status(400).json({ error: 'Code invalide ou expiré' });
    }

    const valid = await bcrypt.compare(code, resets[0].code_hash);
    if (!valid) {
      return res.status(400).json({ error: 'Code incorrect' });
    }

    // Generate a temporary token for the password reset step
    const resetToken = uuidv4();
    await pool.query('UPDATE password_resets SET reset_token = ? WHERE id = ?', [resetToken, resets[0].id]);

    res.json({ resetToken });
  } catch (error) {
    console.error('Verify reset code error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
  try {
    const { resetToken, password } = req.body;
    if (!resetToken || !password) return res.status(400).json({ error: 'Token et mot de passe requis' });
    if (!PASSWORD_REGEX.test(password)) return res.status(400).json({ error: PASSWORD_ERROR });

    const [rows] = await pool.query(
      'SELECT * FROM password_resets WHERE reset_token = ? AND expires_at > NOW() LIMIT 1',
      [resetToken]
    );
    const resets = rows as any[];

    if (resets.length === 0) {
      return res.status(400).json({ error: 'Lien invalide ou expiré. Veuillez recommencer.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, resets[0].user_id]);

    // Cleanup
    await pool.query('DELETE FROM password_resets WHERE user_id = ?', [resets[0].user_id]);

    res.json({ message: 'Mot de passe réinitialisé avec succès' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── Social Auth ──────────────────────────────────────────────

function setCookieAndRespond(res: any, user: any, isAdmin: boolean) {
  const token = generateToken({ id: user.id, email: user.email });
  res.cookie('token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
  res.json({
    user: {
      id: user.id,
      email: user.email,
      full_name: user.full_name,
      first_name: user.first_name,
      last_name: user.last_name,
      phone: user.phone,
      avatar_url: user.avatar_url,
      created_at: user.created_at,
    },
    isAdmin,
    token,
  });
}

// POST /api/auth/social/google
router.post('/social/google', async (req, res) => {
  try {
    const { credential } = req.body; // Google access_token or id_token

    if (!credential) {
      return res.status(400).json({ error: 'Token Google manquant' });
    }

    // Try id_token verification first
    let googleUser: any = null;

    // Try as id_token (from Google One Tap / Sign In)
    const tokenInfoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`);
    if (tokenInfoRes.ok) {
      googleUser = await tokenInfoRes.json();
    } else {
      // Try as access_token (from Google OAuth popup)
      const userInfoRes = await fetch(`https://www.googleapis.com/oauth2/v3/userinfo`, {
        headers: { Authorization: `Bearer ${credential}` },
      });
      if (!userInfoRes.ok) {
        return res.status(401).json({ error: 'Token Google invalide' });
      }
      googleUser = await userInfoRes.json();
    }

    const email = googleUser.email;
    const googleId = googleUser.sub;
    const firstName = googleUser.given_name || googleUser.name?.split(' ')[0] || null;
    const lastName = googleUser.family_name || null;
    const picture = googleUser.picture || null;

    if (!email) {
      return res.status(400).json({ error: 'Email non disponible depuis Google' });
    }

    // Find existing user by email or google_id
    const [existing] = await pool.query(
      'SELECT * FROM users WHERE email = ? OR google_id = ?',
      [email, googleId]
    );
    const users = existing as any[];

    let user;
    if (users.length > 0) {
      user = users[0];
      // Link google_id + update missing info
      await pool.query(
        'UPDATE users SET google_id = ?, first_name = COALESCE(NULLIF(first_name, \'\'), ?), last_name = COALESCE(NULLIF(last_name, \'\'), ?), avatar_url = COALESCE(NULLIF(avatar_url, \'\'), ?) WHERE id = ?',
        [googleId, firstName, lastName, picture, user.id]
      );
      user.first_name = user.first_name || firstName;
      user.last_name = user.last_name || lastName;
      user.avatar_url = user.avatar_url || picture;
    } else {
      const id = uuidv4();
      const fullName = [firstName, lastName].filter(Boolean).join(' ');
      await pool.query(
        'INSERT INTO users (id, email, google_id, first_name, last_name, full_name, avatar_url, email_confirmed_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())',
        [id, email, googleId, firstName, lastName, fullName || null, picture]
      );
      user = { id, email, first_name: firstName, last_name: lastName, full_name: fullName, avatar_url: picture };
    }

    const [roleRows] = await pool.query('SELECT role FROM user_roles WHERE user_id = ? AND role = ?', [user.id, 'admin']);
    const isAdmin = Array.isArray(roleRows) && roleRows.length > 0;

    setCookieAndRespond(res, user, isAdmin);
  } catch (error) {
    console.error('Google auth error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/auth/social/facebook
router.post('/social/facebook', async (req, res) => {
  try {
    const { accessToken } = req.body;

    if (!accessToken) {
      return res.status(400).json({ error: 'Token Facebook manquant' });
    }

    // Verify token with Facebook Graph API
    const fbRes = await fetch(`https://graph.facebook.com/me?fields=id,name,email,first_name,last_name,picture.type(large)&access_token=${accessToken}`);
    if (!fbRes.ok) {
      return res.status(401).json({ error: 'Token Facebook invalide' });
    }

    const fbUser = await fbRes.json();
    const email = fbUser.email;
    const facebookId = fbUser.id;
    const firstName = fbUser.first_name || fbUser.name?.split(' ')[0] || null;
    const lastName = fbUser.last_name || null;
    const picture = fbUser.picture?.data?.url || null;

    if (!email) {
      return res.status(400).json({ error: 'Email non disponible depuis Facebook. Veuillez autoriser l\'accès à votre email.' });
    }

    // Find existing user by email or facebook_id
    const [existing] = await pool.query(
      'SELECT * FROM users WHERE email = ? OR facebook_id = ?',
      [email, facebookId]
    );
    const users = existing as any[];

    let user;
    if (users.length > 0) {
      user = users[0];
      await pool.query(
        'UPDATE users SET facebook_id = ?, first_name = COALESCE(NULLIF(first_name, \'\'), ?), last_name = COALESCE(NULLIF(last_name, \'\'), ?), avatar_url = COALESCE(NULLIF(avatar_url, \'\'), ?) WHERE id = ?',
        [facebookId, firstName, lastName, picture, user.id]
      );
      user.first_name = user.first_name || firstName;
      user.last_name = user.last_name || lastName;
      user.avatar_url = user.avatar_url || picture;
    } else {
      const id = uuidv4();
      const fullName = [firstName, lastName].filter(Boolean).join(' ');
      await pool.query(
        'INSERT INTO users (id, email, facebook_id, first_name, last_name, full_name, avatar_url, email_confirmed_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())',
        [id, email, facebookId, firstName, lastName, fullName || null, picture]
      );
      user = { id, email, first_name: firstName, last_name: lastName, full_name: fullName, avatar_url: picture };
    }

    const [roleRows] = await pool.query('SELECT role FROM user_roles WHERE user_id = ? AND role = ?', [user.id, 'admin']);
    const isAdmin = Array.isArray(roleRows) && roleRows.length > 0;

    setCookieAndRespond(res, user, isAdmin);
  } catch (error) {
    console.error('Facebook auth error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/auth/social/twitter — Twitter/X OAuth 2.0
router.post('/social/twitter', async (req, res) => {
  try {
    const { accessToken } = req.body;

    if (!accessToken) {
      return res.status(400).json({ error: 'Token Twitter manquant' });
    }

    // Verify token with Twitter API v2
    const twitterRes = await fetch('https://api.twitter.com/2/users/me?user.fields=profile_image_url,name,username', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!twitterRes.ok) {
      return res.status(401).json({ error: 'Token Twitter invalide' });
    }

    const twitterData = await twitterRes.json();
    const twitterUser = twitterData.data;
    const twitterId = twitterUser.id;
    const name = twitterUser.name || twitterUser.username;
    const firstName = name?.split(' ')[0] || null;
    const lastName = name?.split(' ').slice(1).join(' ') || null;
    const picture = twitterUser.profile_image_url?.replace('_normal', '') || null;

    // Twitter doesn't always provide email — try to find by twitter_id first
    const [existingById] = await pool.query('SELECT * FROM users WHERE twitter_id = ?', [twitterId]);
    const byIdUsers = existingById as any[];

    let user;
    if (byIdUsers.length > 0) {
      user = byIdUsers[0];
      await pool.query(
        'UPDATE users SET first_name = COALESCE(NULLIF(first_name, \'\'), ?), last_name = COALESCE(NULLIF(last_name, \'\'), ?), avatar_url = COALESCE(NULLIF(avatar_url, \'\'), ?) WHERE id = ?',
        [firstName, lastName, picture, user.id]
      );
    } else {
      // No existing user with this twitter_id — require an email to create account
      return res.status(400).json({ error: 'Impossible de créer un compte via Twitter sans email. Veuillez vous inscrire avec votre email puis lier votre compte Twitter.' });
    }

    const [roleRows] = await pool.query('SELECT role FROM user_roles WHERE user_id = ? AND role = ?', [user.id, 'admin']);
    const isAdmin = Array.isArray(roleRows) && roleRows.length > 0;

    setCookieAndRespond(res, user, isAdmin);
  } catch (error) {
    console.error('Twitter auth error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

export default router;
