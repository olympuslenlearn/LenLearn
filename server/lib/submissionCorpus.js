// Submission-to-submission (peer) similarity.
//
// Stores the passage embeddings of each checked submission in a local corpus
// table and compares new submissions against it, so classmates copying each
// other are caught — not just web sources. Embeddings are kept as JSONB and
// compared in JS, so NO pgvector extension is required (works on any
// PostgreSQL). Every function is defensive: on any error it degrades to a
// no-op so the web-based plagiarism check is never affected.

import { splitIntoSentences } from './plagiarismEngine.js'
import { embedTexts, vectorCosineSimilarity } from './plagiarismAiEngine.js'

const PEER_FLAG_THRESHOLD = 0.35
const MAX_QUERY_PASSAGES = 120
const MAX_STORE_PASSAGES = 120
const MAX_CORPUS_PASSAGES = 6000 // cap how many stored passages we load per compare

let schemaReady = false

async function ensureSchema(pool) {
  if (schemaReady) return
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.submission_corpus (
      id BIGSERIAL PRIMARY KEY,
      student_id VARCHAR(128),
      submission_id BIGINT,
      report_label TEXT,
      passage TEXT NOT NULL,
      embedding JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_submission_corpus_student ON public.submission_corpus (student_id)`,
  )
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_submission_corpus_submission ON public.submission_corpus (submission_id)`,
  )
  schemaReady = true
}

/**
 * Store a submission's passages + embeddings for future peer comparison.
 * @param {import('pg').Pool} pool
 * @param {string} submittedText
 * @param {{ studentId?: string|number, submissionId?: string|number, reportLabel?: string }} meta
 */
export async function addSubmissionToCorpus(pool, submittedText, meta = {}) {
  try {
    if (!pool) return { stored: 0 }
    const studentId = meta.studentId != null ? String(meta.studentId) : null
    if (!studentId) return { stored: 0 }

    const passages = splitIntoSentences(String(submittedText || '')).slice(0, MAX_STORE_PASSAGES)
    if (!passages.length) return { stored: 0 }

    await ensureSchema(pool)

    const embeddings = await embedTexts(passages)
    if (!embeddings.length) return { stored: 0 }

    const submissionId = meta.submissionId != null ? Number(meta.submissionId) : null
    // Replace any prior rows for the same submission so re-checks don't pile up.
    if (submissionId != null && Number.isFinite(submissionId)) {
      await pool.query(`DELETE FROM public.submission_corpus WHERE submission_id = $1`, [submissionId])
    }

    const reportLabel = meta.reportLabel != null ? String(meta.reportLabel).slice(0, 200) : null
    let stored = 0
    for (let i = 0; i < passages.length && i < embeddings.length; i += 1) {
      const vec = embeddings[i]
      if (!Array.isArray(vec) || !vec.length) continue
      await pool.query(
        `INSERT INTO public.submission_corpus (student_id, submission_id, report_label, passage, embedding)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [studentId, submissionId, reportLabel, passages[i], JSON.stringify(vec)],
      )
      stored += 1
    }
    return { stored }
  } catch (e) {
    console.error('[submissionCorpus] store skipped:', e?.message || e)
    return { stored: 0 }
  }
}

/**
 * Compare a submission against previously stored submissions (excluding the same
 * student). Returns a peer similarity score and the matched passages, or null if
 * there is nothing to compare against.
 * @param {import('pg').Pool} pool
 * @param {string} submittedText
 * @param {{ excludeStudentId?: string|number }} opts
 */
export async function comparePeerSubmissions(pool, submittedText, opts = {}) {
  try {
    if (!pool) return null
    const passages = splitIntoSentences(String(submittedText || '')).slice(0, MAX_QUERY_PASSAGES)
    if (!passages.length) return null

    await ensureSchema(pool)

    const excludeStudentId = opts.excludeStudentId != null ? String(opts.excludeStudentId) : null
    const params = []
    let where = ''
    if (excludeStudentId) {
      params.push(excludeStudentId)
      where = `WHERE student_id IS DISTINCT FROM $1`
    }
    params.push(MAX_CORPUS_PASSAGES)
    const { rows } = await pool.query(
      `SELECT student_id, submission_id, report_label, passage, embedding
       FROM public.submission_corpus
       ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
      params,
    )
    if (!rows.length) return null

    const corpus = rows
      .map((r) => {
        let vec = r.embedding
        if (typeof vec === 'string') {
          try { vec = JSON.parse(vec) } catch { vec = null }
        }
        return Array.isArray(vec) && vec.length
          ? {
              studentId: r.student_id,
              submissionId: r.submission_id,
              reportLabel: r.report_label,
              passage: r.passage,
              vec,
            }
          : null
      })
      .filter(Boolean)
    if (!corpus.length) return null

    const queryVecs = await embedTexts(passages)
    if (!queryVecs.length) return null

    const matches = []
    let maxSim = 0
    let sumBest = 0
    let counted = 0
    for (let i = 0; i < passages.length && i < queryVecs.length; i += 1) {
      const qv = queryVecs[i]
      if (!Array.isArray(qv) || !qv.length) continue
      let best = 0
      let bestRow = null
      for (const row of corpus) {
        const sim = vectorCosineSimilarity(qv, row.vec)
        if (sim > best) {
          best = sim
          bestRow = row
        }
      }
      if (best > maxSim) maxSim = best
      sumBest += best
      counted += 1
      if (best >= PEER_FLAG_THRESHOLD && bestRow) {
        matches.push({
          sentence: passages[i],
          similarity: Math.round(best * 1000) / 10,
          matched_student_id: bestRow.studentId,
          matched_submission_id: bestRow.submissionId,
          matched_label: bestRow.reportLabel,
          matched_passage: bestRow.passage,
        })
      }
    }

    const avgBest = counted ? sumBest / counted : 0
    const combined = 0.7 * maxSim + 0.3 * avgBest
    const peer_similarity_score = Math.round(Math.min(100, combined * 100) * 10) / 10
    matches.sort((a, b) => b.similarity - a.similarity)

    return {
      peer_similarity_score,
      peer_matches: matches.slice(0, 25),
    }
  } catch (e) {
    console.error('[submissionCorpus] compare skipped:', e?.message || e)
    return null
  }
}
