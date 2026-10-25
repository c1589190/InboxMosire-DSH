import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * Read and parse one JSON file in the package.
 * @param {string} relative - path relative to the package root.
 * @returns {Promise<Record<string, any>>} parsed document.
 */
async function json(relative) {
  return JSON.parse(await readFile(join(ROOT, relative), 'utf8'))
}

test('the package is a DSH bundle with a display name, locale, and icon', async () => {
  const manifest = await json('package.json')
  assert.equal(manifest.name, '@mosire/dsh-inbox-mosire')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.match(manifest.dsh.engines.dsh, />=0\.2\.0-rc\.2/)
  assert.equal(manifest.exports['.'], './index.js')
  assert.equal(manifest.exports['./tools'], './tools.js')
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json')
  assert.equal(manifest.exports['./icon'], './icon.svg')
  assert.equal(manifest.icon, './icon.svg')
  assert.equal(manifest.dependencies, undefined, 'the bundle has no runtime dependencies')

  const english = await json('locale/en.json')
  const chinese = await json('locale/zh.json')
  assert.ok(english.meta.title.length > 3)
  assert.ok(english.meta.description.length > 20)
  assert.ok(chinese.meta.title.length > 3)
  assert.ok(chinese.meta.description.length > 10)

  const icon = await readFile(join(ROOT, 'icon.svg'), 'utf8')
  assert.match(icon.trimStart(), /^<svg[\s>]/)
  assert.ok((await stat(join(ROOT, 'icon.svg'))).size < 256 * 1024)
})

test('the bundle patch inserts the engine row and the tool row', async () => {
  const patch = await readFile(join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /- insert:/)
  assert.match(patch, /id: inbox-mosire-adapter/)
  assert.match(patch, /name: '@mosire\/dsh-inbox-mosire'\n/)
  assert.match(patch, /id: inbox-mosire-tools/)
  assert.match(patch, /name: '@mosire\/dsh-inbox-mosire\/tools'/)
  assert.ok(!patch.includes('Bearer'), 'the row must not carry a credential')
  assert.ok(!/^\s*token(File)?\s*:/m.test(patch), 'the row must not configure a token')
})

test('the plugin entry exports the Host plugin surface', async () => {
  const entry = await import(join(ROOT, 'index.js'))
  assert.equal(typeof entry.apply, 'function')
  assert.equal(entry.name, 'inbox-mosire-adapter')
  assert.deepEqual(entry.inject, ['agents'])
  const tools = await import(join(ROOT, 'tools.js'))
  assert.equal(typeof tools.apply, 'function')
  assert.deepEqual(tools.inject, ['commands', 'tools'])
  assert.equal(entry.Config, undefined, 'runtime validation replaces a loader schema')
})

test('every advertised file exists', async () => {
  const manifest = await json('package.json')
  for (const entry of manifest.files) {
    if (entry.includes('*')) continue
    const info = await stat(join(ROOT, entry))
    assert.ok(info.isFile() || info.isDirectory(), entry)
  }
  for (const file of ['README.md', 'docs/HOST-CAPABILITIES.md', 'tools.js', 'lib/adapter.js', 'lib/config.js', 'lib/state.js', 'lib/inbox-client.js', 'lib/template.js', 'lib/commands.js', 'lib/log.js']) {
    await stat(join(ROOT, file))
  }
})
