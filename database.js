const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const path = require('path');

const dbPath = path.join(__dirname, 'voting.db');
const db = new sqlite3.Database(dbPath);

// Initialize database
db.serialize(() => {
  // Tabel kandidat
  db.run(`CREATE TABLE IF NOT EXISTS candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nama TEXT NOT NULL,
    kelas TEXT NOT NULL,
    foto TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Tabel kode voting
  db.run(`CREATE TABLE IF NOT EXISTS voting_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kode TEXT UNIQUE NOT NULL,
    is_used BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    used_at DATETIME
  )`);

  // Tabel votes
  db.run(`CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id INTEGER NOT NULL,
    voting_code_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (candidate_id) REFERENCES candidates (id),
    FOREIGN KEY (voting_code_id) REFERENCES voting_codes (id)
  )`);

  // Tabel admin
  db.run(`CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Insert default admin (username: admin, password: admin123)
  const defaultPassword = 'admin123';
  bcrypt.hash(defaultPassword, 10, (err, hash) => {
    if (err) {
      console.error('Error hashing password:', err);
      return;
    }

    db.run(
      'INSERT OR IGNORE INTO admins (username, password) VALUES (?, ?)',
      ['admin', hash],
      function(err) {
        if (err) {
          console.error('Error creating default admin:', err);
        } else if (this.changes > 0) {
          console.log('Default admin created: username=admin, password=admin123');
        }
      }
    );
  });

});

// Update used_at when voting code is used
db.run(`CREATE TRIGGER IF NOT EXISTS update_used_at 
  AFTER UPDATE OF is_used ON voting_codes 
  WHEN NEW.is_used = 1 AND OLD.is_used = 0
  BEGIN
    UPDATE voting_codes SET used_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
  END`);

module.exports = db;