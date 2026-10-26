// Fail publication checks on private data or local artifacts in this source tree.
// This runs without credentials, a database, or network access.
import { readdir, readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const ignoredDirectories = new Set(['node_modules', '.next', '.git', 'coverage', '.turbo'])
const allowedBinary = new Set(['src/app/favicon.ico', 'src/app/fonts/GeistMonoVF.woff', 'src/app/fonts/GeistVF.woff', 'docs/images/calendar.png', 'docs/images/payroll.png'])
const artifactName = /(?:^|\/)(?:\.env(?:\..*)?|[^/]+\.(?:log|dump|bak|sqlite|sqlite3|db|zip|tar|tgz|gz|7z|pem|key|p12|pfx))$/i
const uploadPath = /^(?:uploads?|exports?|backups?)(?:\/|$)/i
const email = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
const privateKey = /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/
const hostedSupabase = /\b(?:https?:\/\/)?[a-z0-9-]{8,}\.supabase\.co\b/i
const forbiddenProjectIdHash = '918ce117ac3a687ebd8855c959eb6730ba355ebd749c425f288db2ca19a3434b'
const projectIdCandidates = /\b[a-z]{20}\b/gi
const providerSecret = /\b(?:sk_(?:live|test)_[a-z0-9]{12,}|whsec_[a-z0-9+/=]{12,}|re_[a-z0-9]{24,})\b/i
const forbiddenBrandDomain = new RegExp(`\\b${['lyve', 'hub'].join('')}\\.com\\b`, 'i')
const allowEmailDomain = /^(?:example\.(?:com|org|net|test|invalid)|[a-z0-9.-]+\.example\.(?:com|org|net|test|invalid)|resend\.dev)$/i
const findings = []

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    const relative = path.relative(root, absolute).replaceAll(path.sep, '/')
    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name)) continue
      if (uploadPath.test(relative)) findings.push(`${relative}: upload/export artifact directory`)
      else await visit(absolute)
      continue
    }
    if (!entry.isFile()) {
      findings.push(`${relative}: unexpected symlink or special file`)
      continue
    }
    if (artifactName.test(relative)) findings.push(`${relative}: local environment or data artifact`)
    if (relative === 'package-lock.json') continue // Public npm package metadata.
    const size = (await stat(absolute)).size
    if (size > 2_000_000) {
      findings.push(`${relative}: unreviewed large file`)
      continue
    }
    const content = await readFile(absolute)
    if (content.includes(0)) {
      if (!allowedBinary.has(relative)) findings.push(`${relative}: unreviewed binary file`)
      continue
    }
    const text = content.toString('utf8')
    for (const [label, pattern] of [
      ['private key', privateKey],
      ['hosted Supabase project', hostedSupabase],
      ['provider secret', providerSecret],
      ['production domain', forbiddenBrandDomain],
    ]) {
      if (pattern.test(text)) findings.push(`${relative}: ${label}`)
    }
    for (const match of text.matchAll(projectIdCandidates)) {
      if (createHash('sha256').update(match[0].toLowerCase()).digest('hex') === forbiddenProjectIdHash) {
        findings.push(`${relative}: production Supabase project ID`)
      }
    }
    for (const match of text.matchAll(email)) {
      const domain = match[0].split('@')[1]
      if (!allowEmailDomain.test(domain)) findings.push(`${relative}: non-example email address`)
    }
  }
}

await visit(root)
if (findings.length) {
  console.error(`Privacy scan failed (${findings.length} finding(s)):`)
  for (const finding of findings) console.error(`- ${finding}`)
  process.exitCode = 1
} else {
  console.log('Privacy scan passed: no private data or local artifacts detected.')
}
