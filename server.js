const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const db = require('./database');

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
app.get('/api/candidates', (req, res) => {
  db.all('SELECT id, nama, kelas, foto FROM candidates ORDER BY nama', (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }
    res.json(rows);
  });
});

// GET - Ambil hasil voting (publik, tanpa auth)
app.get('/api/results', (req, res) => {
  const query = `
    SELECT 
      c.id, c.nama, c.kelas, c.foto,
      COUNT(v.id) as vote_count
    FROM candidates c
    LEFT JOIN votes v ON c.id = v.candidate_id
    GROUP BY c.id, c.nama, c.kelas, c.foto
    ORDER BY vote_count DESC, c.nama
  `;

  db.all(query, (err, results) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }
    res.json(results);
  });
});

// POST - Validasi kode voting
app.post('/api/validate-code', (req, res) => {
  const { votingCode } = req.body;

  if (!votingCode) {
    return res.status(400).json({ error: 'Kode voting diperlukan' });
  }

  // Cek apakah kode voting valid dan belum digunakan
  db.get('SELECT * FROM voting_codes WHERE kode = ? AND is_used = 0', [votingCode], (err, code) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }

    if (!code) {
      return res.status(400).json({ error: 'Kode voting tidak valid atau sudah digunakan' });
    }

    res.json({ valid: true, message: 'Kode voting valid' });
  });
});

// POST - Vote dengan kode unik
app.post('/api/vote', (req, res) => {
  const { votingCode, candidateId } = req.body;

  if (!votingCode || !candidateId) {
    return res.status(400).json({ error: 'Kode voting dan candidate ID diperlukan' });
  }

  // Cek apakah kode voting valid dan belum digunakan
  db.get('SELECT * FROM voting_codes WHERE kode = ? AND is_used = 0', [votingCode], (err, code) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }

    if (!code) {
      return res.status(400).json({ error: 'Kode voting tidak valid atau sudah digunakan' });
    }

    // Cek apakah kandidat ada
    db.get('SELECT * FROM candidates WHERE id = ?', [candidateId], (err, candidate) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }

      if (!candidate) {
        return res.status(400).json({ error: 'Kandidat tidak ditemukan' });
      }

      // Insert vote dan update kode voting
      db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        
        db.run('INSERT INTO votes (candidate_id, voting_code_id) VALUES (?, ?)', 
          [candidateId, code.id], (err) => {
            if (err) {
              db.run('ROLLBACK');
              return res.status(500).json({ error: 'Gagal menyimpan vote' });
            }

            db.run('UPDATE voting_codes SET is_used = 1 WHERE id = ?', [code.id], (err) => {
              if (err) {
                db.run('ROLLBACK');
                return res.status(500).json({ error: 'Gagal update kode voting' });
              }

              db.run('COMMIT');
              res.json({ message: 'Vote berhasil disimpan', candidate: candidate.nama });
            });
          });
      });
    });
  });
});

// POST - Admin login
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username dan password diperlukan' });
  }

  db.get('SELECT * FROM admins WHERE username = ?', [username], async (err, admin) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }

    if (!admin) {
      return res.status(401).json({ error: 'Username atau password salah' });
    }

    try {
      const isValid = await bcrypt.compare(password, admin.password);
      if (!isValid) {
        return res.status(401).json({ error: 'Username atau password salah' });
      }

      const token = jwt.sign({ id: admin.id, username: admin.username }, JWT_SECRET, { expiresIn: '24h' });
      res.json({ token, admin: { id: admin.id, username: admin.username } });
    } catch (error) {
      res.status(500).json({ error: 'Error validating password' });
    }
  });
});

// Admin Routes (Protected)

// GET - Ambil hasil voting
app.get('/api/admin/results', verifyToken, (req, res) => {
  const query = `
    SELECT 
      c.id, c.nama, c.kelas, c.foto,
      COUNT(v.id) as vote_count
    FROM candidates c
    LEFT JOIN votes v ON c.id = v.candidate_id
    GROUP BY c.id, c.nama, c.kelas, c.foto
    ORDER BY vote_count DESC, c.nama
  `;

  db.all(query, (err, results) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }
    res.json(results);
  });
});

// POST - Tambah kandidat
app.post('/api/admin/candidates', verifyToken, upload.single('foto'), (req, res) => {
  const { nama, kelas } = req.body;
  const foto = req.file ? req.file.filename : null;

  if (!nama || !kelas) {
    return res.status(400).json({ error: 'Nama dan kelas diperlukan' });
  }

  db.run('INSERT INTO candidates (nama, kelas, foto) VALUES (?, ?, ?)', 
    [nama, kelas, foto], function(err) {
      if (err) {
        return res.status(500).json({ error: 'Gagal menambah kandidat' });
      }
      res.json({ 
        id: this.lastID, 
        nama, 
        kelas, 
        foto,
        message: 'Kandidat berhasil ditambahkan' 
      });
    });
});

// PUT - Update kandidat
app.put('/api/admin/candidates/:id', verifyToken, upload.single('foto'), (req, res) => {
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

  db.run(query, params, function(err) {
    if (err) {
      return res.status(500).json({ error: 'Gagal update kandidat' });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Kandidat tidak ditemukan' });
    }
    res.json({ message: 'Kandidat berhasil diupdate' });
  });
});

// DELETE - Hapus kandidat
app.delete('/api/admin/candidates/:id', verifyToken, (req, res) => {
  const { id } = req.params;

  db.run('DELETE FROM candidates WHERE id = ?', [id], function(err) {
    if (err) {
      return res.status(500).json({ error: 'Gagal hapus kandidat' });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Kandidat tidak ditemukan' });
    }
    res.json({ message: 'Kandidat berhasil dihapus' });
  });
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

  try {
    // Insert codes one by one with error handling
    const insertPromises = codes.map(code => {
      return new Promise((resolve, reject) => {
        db.run('INSERT INTO voting_codes (kode) VALUES (?)', [code], function(err) {
          if (err) {
            reject(err);
          } else {
            resolve(this.lastID);
          }
        });
      });
    });

    await Promise.all(insertPromises);
    res.json({ codes, message: `${count} kode voting berhasil digenerate` });
    
  } catch (error) {
    console.error('Error generating voting codes:', error);
    res.status(500).json({ error: 'Gagal generate kode voting: ' + error.message });
  }
});

// GET - Ambil semua kode voting
app.get('/api/admin/voting-codes', verifyToken, (req, res) => {
  db.all('SELECT * FROM voting_codes ORDER BY created_at DESC', (err, codes) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }
    res.json(codes);
  });
});

// DELETE - Reset semua kode voting
app.delete('/api/admin/voting-codes/reset', verifyToken, (req, res) => {
  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    
    // Delete all votes first (foreign key constraint)
    db.run('DELETE FROM votes', (err) => {
      if (err) {
        db.run('ROLLBACK');
        return res.status(500).json({ error: 'Gagal menghapus votes' });
      }
      
      // Then delete all voting codes
      db.run('DELETE FROM voting_codes', function(err) {
        if (err) {
          db.run('ROLLBACK');
          return res.status(500).json({ error: 'Gagal reset kode voting' });
        }
        
        db.run('COMMIT', (err) => {
          if (err) {
            return res.status(500).json({ error: 'Gagal commit transaction' });
          }
          res.json({ 
            message: `${this.changes} kode voting berhasil direset`,
            deletedCodes: this.changes 
          });
        });
      });
    });
  });
});

// PUT - Reset individual kode voting
app.put('/api/admin/voting-codes/:id/reset', verifyToken, (req, res) => {
  const { id } = req.params;

  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    
    // Delete votes for this specific code first
    db.run('DELETE FROM votes WHERE voting_code_id = ?', [id], (err) => {
      if (err) {
        db.run('ROLLBACK');
        return res.status(500).json({ error: 'Gagal menghapus vote terkait' });
      }
      
      // Then reset the voting code status
      db.run('UPDATE voting_codes SET is_used = 0, used_at = NULL WHERE id = ?', [id], function(err) {
        if (err) {
          db.run('ROLLBACK');
          return res.status(500).json({ error: 'Gagal reset kode voting' });
        }
        
        if (this.changes === 0) {
          db.run('ROLLBACK');
          return res.status(404).json({ error: 'Kode voting tidak ditemukan' });
        }
        
        db.run('COMMIT', (err) => {
          if (err) {
            return res.status(500).json({ error: 'Gagal commit transaction' });
          }
          res.json({ 
            message: 'Kode voting berhasil direset',
            resetCode: id 
          });
        });
      });
    });
  });
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