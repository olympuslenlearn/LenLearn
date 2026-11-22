// toggle-mfa.mjs — turn LenLearn email-OTP 2FA off/on for portal accounts.
// Usage:  node toggle-mfa.mjs off     (skip OTP: judges log in with password only)
//         node toggle-mfa.mjs on      (restore OTP)
// Leaves the "twoFactor" secret rows intact, so re-enabling is instant.
import 'dotenv/config'
import { Pool } from 'pg'

const arg = String(process.argv[2] || '').toLowerCase()
if (arg !== 'on' && arg !== 'off') {
  console.error('Usage: node toggle-mfa.mjs on   |   node toggle-mfa.mjs off')
  process.exit(1)
}
const on = arg === 'on'

const cs = process.env.DATABASE_URL || ''
if (!cs) {
  console.error('DATABASE_URL is not set in .env')
  process.exit(1)
}
const host = (cs.match(/@([^:/?]+)/) || [])[1] || 'unknown'
const needsSsl = /sslmode=require/i.test(cs) || /ondigitalocean|\.db\.|amazonaws|render\.com/i.test(cs)

const pool = new Pool({
  connectionString: cs,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
})

try {
  const { rowCount } = await pool.query(
    `UPDATE "user"
       SET "twoFactorEnabled" = $1, "updatedAt" = NOW()
     WHERE LOWER(role) IN ('admin','registrar','teacher','faculty','student')`,
    [on],
  )
  console.log(`[${host}] ${on ? 'ENABLED' : 'DISABLED'} 2FA on ${rowCount} account(s).`)
  if (!on) console.log('Judges can now sign in with username + password only. Run "node toggle-mfa.mjs on" afterwards.')
} catch (e) {
  console.error('Failed:', e.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
