require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const pool = require('./database');

const app = express();
const PORT = process.env.PORT || 3001;

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// Middleware
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/')
  },
  filename: function (req, file, cb) {
    const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueName + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  fileFilter: function (req, file, cb) {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'), false);
    }
  },
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB
  }
});

// Middleware untuk verifikasi JWT
const verifyToken = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(403).json({ error: 'Invalid token' });
  }
};

// API Routes

// GET - Ambil semua kandidat
app.get('/api/candidates', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, nama, kelas, foto FROM candidates ORDER BY nama');
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET - Ambil hasil voting (publik, tanpa auth)
app.get('/api/results', async (req, res) => {
  const query = `
    SELECT 
      c.id, c.nama, c.kelas, c.foto,
      COUNT(v.id) as vote_count
    FROM candidates c
    LEFT JOIN votes v ON c.id = v.candidate_id
    GROUP BY c.id, c.nama, c.kelas, c.foto
    ORDER BY vote_count DESC, c.nama
  `;

  try {
    const [results] = await pool.query(query);
    res.json(results);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST - Validasi kode voting
app.post('/api/validate-code', async (req, res) => {
  const { votingCode } = req.body;

  if (!votingCode) {
    return res.status(400).json({ error: 'Kode voting diperlukan' });
  }

  try {
    const [rows] = await pool.query('SELECT * FROM voting_codes WHERE kode = ? AND is_used = 0', [votingCode]);
    const code = rows[0];

    if (!code) {
      return res.status(400).json({ error: 'Kode voting tidak valid atau sudah digunakan' });
    }

    res.json({ valid: true, message: 'Kode voting valid' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST - Vote dengan kode unik
app.post('/api/vote', async (req, res) => {
  const { votingCode, candidateId } = req.body;

  if (!votingCode || !candidateId) {
    return res.status(400).json({ error: 'Kode voting dan candidate ID diperlukan' });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [codeRows] = await connection.query('SELECT * FROM voting_codes WHERE kode = ? AND is_used = 0 FOR UPDATE', [votingCode]);
    const code = codeRows[0];

    if (!code) {
      await connection.rollback();
      return res.status(400).json({ error: 'Kode voting tidak valid atau sudah digunakan' });
    }

    const [candidateRows] = await connection.query('SELECT * FROM candidates WHERE id = ?', [candidateId]);
    const candidate = candidateRows[0];

    if (!candidate) {
      await connection.rollback();
      return res.status(400).json({ error: 'Kandidat tidak ditemukan' });
    }

    await connection.query('INSERT INTO votes (candidate_id, voting_code_id) VALUES (?, ?)', [candidateId, code.id]);
    await connection.query('UPDATE voting_codes SET is_used = 1 WHERE id = ?', [code.id]);

    await connection.commit();
    res.json({ message: 'Vote berhasil disimpan', candidate: candidate.nama });
  } catch (error) {
    console.error(error);
    if (connection) await connection.rollback();
    res.status(500).json({ error: 'Gagal menyimpan vote' });
  } finally {
    if (connection) connection.release();
  }
});

// POST - Admin login
app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username dan password diperlukan' });
  }

  try {
    const [rows] = await pool.query('SELECT * FROM admins WHERE username = ?', [username]);
    const admin = rows[0];

    if (!admin) {
      return res.status(401).json({ error: 'Username atau password salah' });
    }

    const isValid = await bcrypt.compare(password, admin.password);
    if (!isValid) {
      return res.status(401).json({ error: 'Username atau password salah' });
    }

    const token = jwt.sign({ id: admin.id, username: admin.username }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, admin: { id: admin.id, username: admin.username } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error validating password' });
  }
});

// Admin Routes (Protected)

// GET - Ambil hasil voting
app.get('/api/admin/results', verifyToken, async (req, res) => {
  const query = `
    SELECT 
      c.id, c.nama, c.kelas, c.foto,
      COUNT(v.id) as vote_count
    FROM candidates c
    LEFT JOIN votes v ON c.id = v.candidate_id
    GROUP BY c.id, c.nama, c.kelas, c.foto
    ORDER BY vote_count DESC, c.nama
  `;

  try {
    const [results] = await pool.query(query);
    res.json(results);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST - Tambah kandidat
app.post('/api/admin/candidates', verifyToken, upload.single('foto'), async (req, res) => {
  const { nama, kelas } = req.body;
  const foto = req.file ? req.file.filename : null;

  if (!nama || !kelas) {
    return res.status(400).json({ error: 'Nama dan kelas diperlukan' });
  }

  try {
    const [result] = await pool.query('INSERT INTO candidates (nama, kelas, foto) VALUES (?, ?, ?)', [nama, kelas, foto]);
    res.json({ 
      id: result.insertId, 
      nama, 
      kelas, 
      foto,
      message: 'Kandidat berhasil ditambahkan' 
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Gagal menambah kandidat' });
  }
});

// PUT - Update kandidat
app.put('/api/admin/candidates/:id', verifyToken, upload.single('foto'), async (req, res) => {
  const { id } = req.params;
  const { nama, kelas } = req.body;
  const foto = req.file ? req.file.filename : null;

  if (!nama || !kelas) {
    return res.status(400).json({ error: 'Nama dan kelas diperlukan' });
  }

  let query, params;
  if (foto) {
    query = 'UPDATE candidates SET nama = ?, kelas = ?, foto = ? WHERE id = ?';
    params = [nama, kelas, foto, id];
  } else {
    query = 'UPDATE candidates SET nama = ?, kelas = ? WHERE id = ?';
    params = [nama, kelas, id];
  }

  try {
    const [result] = await pool.query(query, params);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Kandidat tidak ditemukan' });
    }
    res.json({ message: 'Kandidat berhasil diupdate' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Gagal update kandidat' });
  }
});

// DELETE - Hapus kandidat
app.delete('/api/admin/candidates/:id', verifyToken, async (req, res) => {
  const { id } = req.params;

  try {
    const [result] = await pool.query('DELETE FROM candidates WHERE id = ?', [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Kandidat tidak ditemukan' });
    }
    res.json({ message: 'Kandidat berhasil dihapus' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Gagal hapus kandidat' });
  }
});

// POST - Generate kode voting
app.post('/api/admin/voting-codes', verifyToken, async (req, res) => {
  const { count = 1 } = req.body;
  
  if (!count || count < 1 || count > 1000) {
    return res.status(400).json({ error: 'Jumlah kode harus antara 1-1000' });
  }
  
  const codes = [];
  for (let i = 0; i < count; i++) {
    codes.push(uuidv4().substring(0, 8).toUpperCase());
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const values = codes.map(code => [code]);
    await connection.query('INSERT INTO voting_codes (kode) VALUES ?', [values]);
    
    await connection.commit();
    res.json({ codes, message: `${count} kode voting berhasil digenerate` });
  } catch (error) {
    console.error('Error generating voting codes:', error);
    if (connection) await connection.rollback();
    res.status(500).json({ error: 'Gagal generate kode voting: ' + error.message });
  } finally {
    if (connection) connection.release();
  }
});

// GET - Ambil semua kode voting
app.get('/api/admin/voting-codes', verifyToken, async (req, res) => {
  try {
    const [codes] = await pool.query('SELECT * FROM voting_codes ORDER BY created_at DESC');
    res.json(codes);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Database error' });
  }
});

// DELETE - Reset semua kode voting
app.delete('/api/admin/voting-codes/reset', verifyToken, async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    
    // Delete all votes first (foreign key constraint)
    await connection.query('DELETE FROM votes');
    
    // Then delete all voting codes
    const [result] = await connection.query('DELETE FROM voting_codes');
    
    await connection.commit();
    res.json({ 
      message: `${result.affectedRows} kode voting berhasil direset`,
      deletedCodes: result.affectedRows 
    });
  } catch (error) {
    console.error(error);
    if (connection) await connection.rollback();
    res.status(500).json({ error: 'Gagal reset kode voting' });
  } finally {
    if (connection) connection.release();
  }
});

// PUT - Reset individual kode voting
app.put('/api/admin/voting-codes/:id/reset', verifyToken, async (req, res) => {
  const { id } = req.params;

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    
    // Delete votes for this specific code first
    await connection.query('DELETE FROM votes WHERE voting_code_id = ?', [id]);
    
    // Then reset the voting code status
    const [result] = await connection.query('UPDATE voting_codes SET is_used = 0, used_at = NULL WHERE id = ?', [id]);
    
    if (result.affectedRows === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Kode voting tidak ditemukan' });
    }
    
    await connection.commit();
    res.json({ 
      message: 'Kode voting berhasil direset',
      resetCode: id 
    });
  } catch (error) {
    console.error(error);
    if (connection) await connection.rollback();
    res.status(500).json({ error: 'Gagal reset kode voting' });
  } finally {
    if (connection) connection.release();
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File terlalu besar. Maksimal 5MB' });
    }
  }
  
  if (error.message === 'Only image files are allowed!') {
    return res.status(400).json({ error: 'Hanya file gambar yang diizinkan' });
  }
  
  res.status(500).json({ error: 'Internal server error' });
});

// Create uploads directory if it doesn't exist
const fs = require('fs');
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

app.listen(PORT, () => {
  console.log(`Server berjalan di port ${PORT}`);
});