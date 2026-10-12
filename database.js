const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'evoting',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

async function initDB() {
  try {
    // Tabel kandidat
    await pool.query(`CREATE TABLE IF NOT EXISTS candidates (
      id INT AUTO_INCREMENT PRIMARY KEY,
      nama VARCHAR(255) NOT NULL,
      kelas VARCHAR(255) NOT NULL,
      foto VARCHAR(255),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Tabel kode voting
    await pool.query(`CREATE TABLE IF NOT EXISTS voting_codes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      kode VARCHAR(50) UNIQUE NOT NULL,
      is_used BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      used_at DATETIME
    )`);

    // Tabel votes
    await pool.query(`CREATE TABLE IF NOT EXISTS votes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      candidate_id INT NOT NULL,
      voting_code_id INT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (candidate_id) REFERENCES candidates (id),
      FOREIGN KEY (voting_code_id) REFERENCES voting_codes (id)
    )`);

    // Tabel admin
    await pool.query(`CREATE TABLE IF NOT EXISTS admins (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Insert default admin (username: admin, password: admin123)
    const [admins] = await pool.query('SELECT * FROM admins WHERE username = ?', ['admin']);
    if (admins.length === 0) {
      const defaultPassword = 'admin123';
      const hash = await bcrypt.hash(defaultPassword, 10);
      await pool.query(
        'INSERT INTO admins (username, password) VALUES (?, ?)',
        ['admin', hash]
      );
      console.log('Default admin created: username=admin, password=admin123');
    }

    // Buat Trigger untuk update used_at
    await pool.query('DROP TRIGGER IF EXISTS update_used_at');
    await pool.query(`
      CREATE TRIGGER update_used_at 
      BEFORE UPDATE ON voting_codes 
      FOR EACH ROW
      BEGIN
        IF NEW.is_used = 1 AND OLD.is_used = 0 THEN
          SET NEW.used_at = CURRENT_TIMESTAMP;
        END IF;
      END
    `);

    console.log('Database MySQL terhubung dan tabel berhasil diinisialisasi.');
  } catch (error) {
    console.error('Database initialization error:', error);
  }
}

initDB();

module.exports = pool;