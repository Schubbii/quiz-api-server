const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

const app = express();

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'quiz.sqlite');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'bitte-aendern';

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new sqlite3.Database(DB_PATH, (error) => {
  if (error) {
    console.error('Fehler beim Öffnen der Datenbank:', error);
    process.exit(1);
  }
  console.log('SQLite geöffnet:', DB_PATH);
});

db.serialize(() => {
  db.run('PRAGMA foreign_keys = ON');
});

app.use(cors());
app.use(express.json({ limit: '1mb' }));

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) reject(error);
      else resolve(rows);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) reject(error);
      else resolve(row);
    });
  });
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) reject(error);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

async function ensureSchema() {
  await run(`
    CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question TEXT NOT NULL,
      category TEXT NOT NULL,
      difficulty TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_id INTEGER NOT NULL,
      answer_text TEXT NOT NULL,
      is_correct INTEGER NOT NULL DEFAULT 0,
      order_index INTEGER NOT NULL,
      FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
    )
  `);
}

function normalizeQuestion(questionData) {
  return {
    question: String(questionData.question || '').trim(),
    answers: Array.isArray(questionData.answers)
      ? questionData.answers.map((answer) => String(answer).trim()).filter(Boolean)
      : [],
    correctAnswerIndex: Number(questionData.correctAnswerIndex),
    category: String(questionData.category || '').trim(),
    difficulty: String(questionData.difficulty || '').trim(),
  };
}

function validateQuestion(questionData) {
  if (!questionData.question) throw new Error('Fragetext fehlt.');
  if (!Array.isArray(questionData.answers) || questionData.answers.length < 2) {
    throw new Error('Mindestens zwei Antwortmöglichkeiten sind erforderlich.');
  }
  if (!Number.isInteger(questionData.correctAnswerIndex) || questionData.correctAnswerIndex < 0 || questionData.correctAnswerIndex >= questionData.answers.length) {
    throw new Error('Der Index der richtigen Antwort ist ungültig.');
  }
  if (!questionData.category) throw new Error('Kategorie fehlt.');
  if (!questionData.difficulty) throw new Error('Schwierigkeit fehlt.');
}

async function mapQuestionRows(rows) {
  const questions = [];

  for (const row of rows) {
    const answers = await all(
      `SELECT answer_text, is_correct, order_index
       FROM answers
       WHERE question_id = ?
       ORDER BY order_index ASC`,
      [row.id]
    );

    questions.push({
      id: row.id,
      question: row.question,
      answers: answers.map((answer) => answer.answer_text),
      correctAnswerIndex: answers.findIndex((answer) => Number(answer.is_correct) === 1),
      category: row.category,
      difficulty: row.difficulty,
    });
  }

  return questions;
}

function requireAdmin(req, res, next) {
  const token = req.header('x-admin-token');

  console.log('--- ADMIN CHECK ---');
  console.log('Header token:', JSON.stringify(token));
  console.log('Env token:', JSON.stringify(ADMIN_TOKEN));

  if (!token || token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Nicht autorisiert.' });
  }

  next();
}

app.get('/', (_req, res) => {
  res.json({ ok: true, message: 'Quiz API läuft.' });
});

app.get('/health', async (_req, res) => {
  const row = await get('SELECT COUNT(*) AS count FROM questions');
  res.json({ ok: true, questions: row?.count || 0 });
});

app.get('/questions', async (_req, res) => {
  try {
    const rows = await all('SELECT id, question, category, difficulty FROM questions ORDER BY id ASC');
    const questions = await mapQuestionRows(rows);
    res.json(questions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/questions/round', async (req, res) => {
  try {
    const { category = 'all', difficulty = 'all', count = '10' } = req.query;
    const params = [];
    const conditions = [];

    if (category && category !== 'all') {
      conditions.push('category = ?');
      params.push(category);
    }

    if (difficulty && difficulty !== 'all') {
      conditions.push('difficulty = ?');
      params.push(difficulty);
    }

    const limit = Number(count) > 0 ? Number(count) : 10;
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = await all(
      `SELECT id, question, category, difficulty
       FROM questions
       ${whereClause}
       ORDER BY RANDOM()
       LIMIT ?`,
      [...params, limit]
    );

    const questions = await mapQuestionRows(rows);
    res.json(questions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/questions', requireAdmin, async (req, res) => {
  try {
    const questionData = normalizeQuestion(req.body);
    validateQuestion(questionData);

    const questionResult = await run(
      `INSERT INTO questions (question, category, difficulty)
       VALUES (?, ?, ?)`,
      [questionData.question, questionData.category, questionData.difficulty]
    );

    const questionId = questionResult.lastID;

    for (let index = 0; index < questionData.answers.length; index += 1) {
      await run(
        `INSERT INTO answers (question_id, answer_text, is_correct, order_index)
         VALUES (?, ?, ?, ?)`,
        [questionId, questionData.answers[index], index === questionData.correctAnswerIndex ? 1 : 0, index]
      );
    }

    res.status(201).json({ id: questionId, ...questionData });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.put('/questions/:id', requireAdmin, async (req, res) => {
  try {
    const numericId = Number(req.params.id);
    const existingQuestion = await get(
      'SELECT id, question, category, difficulty FROM questions WHERE id = ?',
      [numericId]
    );

    if (!existingQuestion) {
      return res.status(404).json({ error: `Frage mit ID ${req.params.id} wurde nicht gefunden.` });
    }

    const questionData = normalizeQuestion(req.body);
    validateQuestion(questionData);

    await run(
      `UPDATE questions
       SET question = ?, category = ?, difficulty = ?
       WHERE id = ?`,
      [questionData.question, questionData.category, questionData.difficulty, numericId]
    );

    await run('DELETE FROM answers WHERE question_id = ?', [numericId]);

    for (let index = 0; index < questionData.answers.length; index += 1) {
      await run(
        `INSERT INTO answers (question_id, answer_text, is_correct, order_index)
         VALUES (?, ?, ?, ?)`,
        [numericId, questionData.answers[index], index === questionData.correctAnswerIndex ? 1 : 0, index]
      );
    }

    res.json({ id: numericId, ...questionData });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/questions/:id', requireAdmin, async (req, res) => {
  try {
    const numericId = Number(req.params.id);
    const existingQuestion = await get('SELECT id FROM questions WHERE id = ?', [numericId]);

    if (!existingQuestion) {
      return res.status(404).json({ error: `Frage mit ID ${req.params.id} wurde nicht gefunden.` });
    }

    await run('DELETE FROM questions WHERE id = ?', [numericId]);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;

ensureSchema()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Quiz API läuft auf Port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Schema konnte nicht initialisiert werden:', error);
    process.exit(1);
  });