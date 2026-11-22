// list-teachers.mjs — read-only: prints teacher/faculty accounts.
// Usage:  node list-teachers.mjs
// Never prints passwords (stored only as hashes).
import 'dotenv/config'
import { Pool } from 'pg'

let cs = process.env.DATABASE_URL || ''
if (!cs) { console.error('DATABASE_URL is not set'); process.exit(1) }
cs = cs.replace(/([?&])sslmode=[^&]*/gi,'$1').replace(/([?&])sslrootcert=[^&]*/gi,'$1').replace(/[?&]+$/,'').replace(/\?&/,'?')
const isRemote = !/@(localhost|127\.0\.0\.1)/i.test(cs)
const pool = new Pool({ connectionString: cs, ssl: isRemote ? { rejectUnauthorized: false } : false })

try {
  // Auth accounts with a teacher/faculty role
  const { rows: users } = await pool.query(
    `SELECT id, username, "displayUsername", email, role, name,
            "twoFactorEnabled", "emailVerified", "failedLoginAttempts", "lockedUntil", "createdAt"
       FROM "user"
      WHERE LOWER(role) IN ('teacher','faculty')
      ORDER BY "createdAt" NULLS LAST, username`
  )
  console.log(`\n=== Teacher/Faculty auth accounts: ${users.length} ===`)
  for (const u of users) {
    console.log(
      `- ${u.username || u.displayUsername || '(no username)'} | ${u.email || ''} | role=${u.role}` +
      ` | 2FA=${u.twoFactorEnabled ? 'on' : 'off'}` +
      (u.lockedUntil ? ` | LOCKED until ${new Date(u.lockedUntil).toISOString()}` : '')
    )
  }

  // Faculty profile records (if the faculties table exists)
  try {
    const { rows: fac } = await pool.query(
      `SELECT id, faculty_code, first_name, middle_name, last_name, email, grade_level
         FROM faculties ORDER BY last_name, first_name`
    )
    console.log(`\n=== Faculty profile records (faculties table): ${fac.length} ===`)
    for (const f of fac) {
      const nm = [f.first_name, f.middle_name, f.last_name].filter(Boolean).join(' ')
      console.log(`- ${f.faculty_code || f.id} | ${nm} | ${f.email || ''}${f.grade_level ? ' | grade ' + f.grade_level : ''}`)
    }
  } catch {
    console.log('\n(faculties table not found or has different columns — skipping profile list)')
  }
} catch (e) {
  console.error('Query failed:', e.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
