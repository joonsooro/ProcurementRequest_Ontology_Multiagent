/** Apply the foundation in dependency order: instance tables → object/property/link catalog → action metadata → optional demo data.
 * All SQL is copied/generated into a temporary directory and applied through the project's run-sql command.
 * No seed reset, schema DROP, or existing operational row replacement is performed.
 */
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { buildCatalogSql } from './catalog.ts'
import { buildActionMetadataSql } from './schema.ts'
const root = fileURLToPath(new URL('../../../', import.meta.url))
const directory = await mkdtemp(join(tmpdir(), 'procurement-foundation-'))
try {
  const steps = [await readFile(new URL('./db/foundation.sql', import.meta.url), 'utf8'), buildCatalogSql(), buildActionMetadataSql()]
  if (process.argv.includes('--demo')) steps.push(await readFile(new URL('./db/demo.sql', import.meta.url), 'utf8'))
  for (const [index, sql] of steps.entries()) {
    const path = join(directory, `step-${index + 1}.sql`)
    await writeFile(path, sql, { mode: 0o600 })
    const result = spawnSync('pnpm', ['run-sql', path], { cwd: root, stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`Step ${index + 1} failed; later steps were not applied`)
  }
  console.log('Procurement foundation applied. Existing instance rows were preserved.')
} finally { await rm(directory, { recursive: true, force: true }) }
