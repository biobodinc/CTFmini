// api/leaderboard.js — global leaderboard for Defenders
// Works with ANY Postgres: local (postgres://user:pass@localhost:5432/defenders),
// Supabase, Neon, whatever. Set DATABASE_URL to the connection string.
//
// GET  -> top 10 scores
// POST -> { name: "ABC", score: 123.4 } -> saves + returns updated top 10

import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3,                          // serverless: keep the pool tiny
  // Hosted Postgres (Supabase/Neon) requires SSL; local usually doesn't.
  ssl: process.env.DATABASE_URL?.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
});

const MAX_SCORE = 7200; // 2 hours — nobody legitimately holds longer
const NAME_RE = /^[A-Z0-9]{1,3}$/;

// Basic per-IP rate limit. In-memory, so it resets when the serverless
// instance recycles — stops casual spam, not a determined attacker.
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => t > now - 60_000);
  if (list.length >= 5) return true;
  list.push(now);
  hits.set(ip, list);
  return false;
}

async function topTen() {
  const { rows } = await pool.query(
    `SELECT name, score FROM scores
     ORDER BY score DESC, created_at ASC
     LIMIT 10`
  );
  return rows.map(r => ({ name: r.name, score: Number(r.score) }));
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=30');
      return res.status(200).json(await topTen());
    }

    if (req.method === 'POST') {
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
      if (rateLimited(ip)) {
        return res.status(429).json({ error: 'Too many submissions — slow down.' });
      }

      const { name, score } = req.body || {};
      const cleanName = String(name || '').toUpperCase().trim();
      const numScore = Number(score);

      if (!NAME_RE.test(cleanName)) {
        return res.status(400).json({ error: 'Name must be 1–3 letters or digits.' });
      }
      if (!Number.isFinite(numScore) || numScore < 1 || numScore > MAX_SCORE) {
        return res.status(400).json({ error: 'Invalid score.' });
      }

      await pool.query(
        'INSERT INTO scores (name, score) VALUES ($1, $2)',
        [cleanName, Math.round(numScore * 10) / 10]
      );
      return res.status(200).json(await topTen());
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  } catch (err) {
    console.error('leaderboard error:', err);
    return res.status(500).json({ error: 'Leaderboard unavailable.' });
  }
}
