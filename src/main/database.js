const Database = require('better-sqlite3');
const path = require('path');
const { app } = require('electron');

class DB {
  constructor() {
    const dbPath = path.join(app.getPath('userData'), 'chessstream.db');
    this.db = new Database(dbPath);
  }

  init() {
    this.db.exec(`
      -- Fila ativa de desafiantes
      CREATE TABLE IF NOT EXISTS queue (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        username    TEXT NOT NULL,
        chess_nick  TEXT NOT NULL,
        priority    INTEGER NOT NULL DEFAULT 4,
        platform    TEXT NOT NULL DEFAULT 'twitch',
        joined_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(username)
      );

      -- Usuários com assinaturas/pagamentos reconhecidos
      CREATE TABLE IF NOT EXISTS subscribers (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        username      TEXT NOT NULL UNIQUE,
        chess_nick    TEXT,
        platform      TEXT,
        sub_type      TEXT DEFAULT 'paid',  -- 'paid' | 'twitch_sub' | 'yt_member'
        active        INTEGER DEFAULT 1,
        expires_at    DATETIME,
        created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- Histórico de partidas (para evitar reprocessar)
      CREATE TABLE IF NOT EXISTS game_history (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        game_uuid   TEXT NOT NULL UNIQUE,
        opponent    TEXT,
        result      TEXT,
        played_at   DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  // ── Fila ────────────────────────────────────────────────────────────────────
  addToQueue({ username, chessNick, priority, platform }) {
    return this.db.prepare(`
      INSERT OR IGNORE INTO queue (username, chess_nick, priority, platform)
      VALUES (?, ?, ?, ?)
    `).run(username, chessNick, priority, platform);
  }

  removeFromQueue(username) {
    return this.db.prepare(`DELETE FROM queue WHERE username = ?`).run(username);
  }

  getQueue() {
    return this.db.prepare(`
      SELECT * FROM queue ORDER BY priority ASC, joined_at ASC
    `).all();
  }

  getQueuePosition(username) {
    const queue = this.getQueue();
    return queue.findIndex(p => p.username === username) + 1;
  }

  clearQueue() {
    return this.db.prepare(`DELETE FROM queue`).run();
  }

  // ── Assinantes ──────────────────────────────────────────────────────────────
  upsertSubscriber({ username, chessNick, platform, subType, expiresAt }) {
    return this.db.prepare(`
      INSERT INTO subscribers (username, chess_nick, platform, sub_type, active, expires_at)
      VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT(username) DO UPDATE SET
        chess_nick = excluded.chess_nick,
        sub_type   = excluded.sub_type,
        active     = 1,
        expires_at = excluded.expires_at
    `).run(username, chessNick, platform, subType, expiresAt || null);
  }

  getSubscriber(username) {
    return this.db.prepare(`
      SELECT * FROM subscribers WHERE username = ? AND active = 1
    `).get(username);
  }

  // ── Histórico ───────────────────────────────────────────────────────────────
  gameExists(uuid) {
    return !!this.db.prepare(`SELECT 1 FROM game_history WHERE game_uuid = ?`).get(uuid);
  }

  saveGame({ uuid, opponent, result }) {
    return this.db.prepare(`
      INSERT OR IGNORE INTO game_history (game_uuid, opponent, result)
      VALUES (?, ?, ?)
    `).run(uuid, opponent, result);
  }
}

module.exports = DB;
