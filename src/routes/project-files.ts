import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuid } from 'uuid';
import pool from '../db/connection';
import { authenticate, requireAdmin } from '../middleware/auth';

const router = Router();
const uploadsDir = path.join(process.cwd(), 'uploads', 'documents');

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${uniqueSuffix}${path.extname(file.originalname)}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowedTypes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/plain',
      'image/jpeg',
      'image/png',
      'image/webp',
    ];

    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Type de fichier non autorise'));
    }
  },
});

router.get('/section/:sectionId', async (req: Request, res: Response) => {
  try {
    const { sectionId } = req.params;
    const [rows] = await pool.query(
      'SELECT id, project_section_id, file_url, file_name, file_size, file_type, created_at FROM project_files WHERE project_section_id = ? ORDER BY created_at DESC',
      [sectionId]
    );

    res.json(rows);
  } catch (err) {
    console.error('Error fetching project files:', err);
    res.status(500).json({ error: 'Error fetching project files' });
  }
});

router.post('/', [authenticate, requireAdmin, upload.single('file')], async (req: Request, res: Response) => {
  try {
    const projectSectionId = (req.body.project_section_id || '').trim();

    if (!projectSectionId) {
      if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'project_section_id requis' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Aucun fichier fourni' });
    }

    const rawCustomName = (req.body.file_name || '').toString().trim();
    const sanitizedBaseName = rawCustomName
      .replace(/[\\/<>:"|?*\x00-\x1F]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);

    const originalExt = path.extname(req.file.originalname);
    let finalDisplayName = req.file.originalname;
    if (sanitizedBaseName) {
      finalDisplayName = sanitizedBaseName;
      if (originalExt && !sanitizedBaseName.toLowerCase().endsWith(originalExt.toLowerCase())) {
        finalDisplayName = `${sanitizedBaseName}${originalExt}`;
      }
    }

    const [countRows] = await pool.query(
      'SELECT COUNT(*) AS cnt FROM project_files WHERE project_section_id = ?',
      [projectSectionId]
    ) as any[];

    const currentCount = Number(countRows?.[0]?.cnt || 0);
    if (currentCount >= 3) {
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Maximum 3 fichiers par zone' });
    }

    const id = uuid();
    const fileUrl = `/uploads/documents/${req.file.filename}`;

    await pool.query(
      'INSERT INTO project_files (id, project_section_id, file_url, file_name, file_size, file_type) VALUES (?, ?, ?, ?, ?, ?)',
      [id, projectSectionId, fileUrl, finalDisplayName, req.file.size, req.file.mimetype]
    );

    res.json({
      id,
      project_section_id: projectSectionId,
      file_url: fileUrl,
      file_name: finalDisplayName,
      file_size: req.file.size,
      file_type: req.file.mimetype,
    });
  } catch (err) {
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    console.error('Error uploading project file:', err);
    res.status(500).json({ error: 'Error uploading project file' });
  }
});

router.delete('/:id', [authenticate, requireAdmin], async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.query('SELECT file_url FROM project_files WHERE id = ?', [id]) as any[];

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(404).json({ error: 'Fichier introuvable' });
    }

    const fileUrl: string = rows[0].file_url || '';
    await pool.query('DELETE FROM project_files WHERE id = ?', [id]);

    if (fileUrl.startsWith('/uploads/')) {
      const localPath = path.join(process.cwd(), fileUrl.replace(/^\//, ''));
      if (fs.existsSync(localPath)) {
        fs.unlinkSync(localPath);
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting project file:', err);
    res.status(500).json({ error: 'Error deleting project file' });
  }
});

export default router;
