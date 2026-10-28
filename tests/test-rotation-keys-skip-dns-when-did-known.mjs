#!/usr/bin/env node
// Right after creating an account, the Account tab's detail view shows
// rotation keys by resolving the account's own handle (selectAccount's
// upsertKnownAccount({ did, handle, pds }) only has these three fields -
// see renderAccountDetail -> resolveSelectedAccount -> resolveAccountForManagement
// in index.html). That handle resolution goes through DNS TXT, falling back to
// .well-known/atproto-did - both of which can lag well behind account creation
// (a freshly registered handle's DNS/well-known isn't necessarily live yet),
// even though the DID is already known with certainty (the same createAccount
// response that returned did also returned handle and pds, all at once, from
// the PDS itself).
//
// Forces exactly that lag: creates a real account, then intercepts both
// resolution methods for this exact handle so they fail deterministically
// (not dependent on real DNS timing, so this isn't flaky either way), and
// confirms rotation keys still display - because the DID is already known,
// there's nothing to wait on DNS for.
//
// Usage: node test-rotation-keys-skip-dns-when-did-known.mjs [handle-subdomain]

import { chromium } from 'playwright'
import fs from 'node:fs/promises'

const ONBOARD_URL = process.env.ONBOARD_URL || 'https://ens.goat.navy/'
const PDS_ENDPOINT = process.env.PDS_ENDPOINT || 'https://vlpds.goat.navy'
const ACCOUNT_PASSWORD = process.env.PDS_ACCOUNT_PASSWORD
if (!ACCOUNT_PASSWORD) throw new Error('Set PDS_ACCOUNT_PASSWORD (shared test-account password)')
const SEED_PATH = process.env.SEED_PATH || `${process.env.HOME}/.config/onboard-test/seed.txt`
const subdomain = process.argv[2] || `dnslag${Date.now().toString(36)}`

async function main() {
  const serverInfo = await fetch(`${PDS_ENDPOINT}/xrpc/com.atproto.server.describeServer`).then((r) => r.json())

  const browser = await chromium.launch()
  const page = await browser.newPage()
  page.on('pageerror', (err) => console.log(`[pageerror] ${err}`))

  // Force both handle-resolution methods to fail, for ANY handle - the only
  // handle this test ever resolves is the one it's about to create, so this
  // doesn't need to be scoped more narrowly. Registered before account
  // creation, since selectAccount() (and the resolution it triggers) fires
  // synchronously as part of that flow, not after this script does anything
  // else.
  await page.route('https://cloudflare-dns.com/dns-query**', (route) =>
    route.fulfill({ contentType: 'application/dns-json', body: JSON.stringify({ Status: 3 }) }), // NXDOMAIN, no Answer
  )
  await page.route('**/.well-known/atproto-did', (route) => route.abort('addressunreachable'))

  await page.goto(ONBOARD_URL)

  const mnemonic = (await fs.readFile(SEED_PATH, 'utf8')).trim()
  await page.fill('#mnemonicInput', mnemonic)
  await page.click('#restoreBtn')
  await page.waitForSelector('#didKeyText:not(:empty)', { timeout: 10000, state: 'attached' })

  await page.click('#createaccount-tab')
  await page.fill('#pds-endpoint', '')
  await page.fill('#pds-endpoint', PDS_ENDPOINT)
  await page.locator('#pds-endpoint').blur()

  await page.waitForSelector('#account-handle-domain option:not([value=""])', { timeout: 10000, state: 'attached' })
  const handleDomain = await page.locator('#account-handle-domain option:not([value=""])').first().getAttribute('value')
  await page.selectOption('#account-handle-domain', handleDomain)
  const handle = handleDomain.startsWith('.') ? `${subdomain}${handleDomain}` : `${subdomain}.${handleDomain}`
  console.log(`handle: ${handle} (its DNS TXT and .well-known are forced to fail for this whole test)`)

  await page.fill('#account-handle-subdomain', subdomain)
  await page.fill('#account-email', `${subdomain}@test.invalid`)
  await page.fill('#account-password', ACCOUNT_PASSWORD)
  if (serverInfo.inviteCodeRequired) throw new Error('This PDS requires an invite code - pick one without that for this test')

  await page.click('#submit-createaccount-btn')

  const status = await page.waitForFunction(() => {
    const el = document.getElementById('status-line')
    if (!el) return null
    if (el.querySelector('.status.error')) return el.textContent || ''
    const text = el.textContent || ''
    if (/account created/i.test(text)) return text
    return null
  }, null, { timeout: 30000 }).then((h) => h.jsonValue())
  if (!/account created/i.test(status)) throw new Error(`account creation did not succeed: ${status}`)
  console.log('account created:', status)

  // The actual check: the Account tab's detail view shows rotation keys for
  // the just-created account without ever needing DNS/.well-known, since the
  // DID is already known.
  const rotationKeysEl = page.locator('#account-detail-rotation-keys')
  await rotationKeysEl.waitFor({ state: 'visible', timeout: 10000 })
  await page.waitForFunction(() => {
    const el = document.getElementById('account-detail-rotation-keys')
    return el && el.textContent.trim() !== 'Loading...'
  }, null, { timeout: 15000 })
  const rotationKeysText = (await rotationKeysEl.textContent()).trim()
  console.log('rotation keys cell:', rotationKeysText)

  if (rotationKeysText.startsWith('could not load')) {
    throw new Error(`FAIL: rotation keys blocked on handle resolution despite the DID already being known: ${rotationKeysText}`)
  }
  console.log('--- PASS: rotation keys displayed without needing DNS/.well-known ---')

  await browser.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
