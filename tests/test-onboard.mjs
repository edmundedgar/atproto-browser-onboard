#!/usr/bin/env node
// Drives the real onboarding flow (generate key -> create DID:PLC -> createAccount
// -> submit DID update -> activateAccount) against a live ens.goat.navy + any PDS,
// using a real headless browser so the page's own JS runs unmodified.
//
// PDS-agnostic by design, so the same script runs against any implementation:
// the handle domain is read from whatever the PDS's own describeServer/select
// options actually offer rather than assumed, and an invite code is only
// created (via the reference-PDS-style admin:PASSWORD Basic auth) when
// describeServer reports one is actually required - a PDS with a different
// admin model (e.g. per-account is_admin instead of a shared admin secret)
// just needs invite codes turned off for testing, same as if it were behind
// no invite gate at all.
//
// Usage: node test-onboard.mjs [handle-subdomain]

import { chromium } from 'playwright'
import fs from 'node:fs/promises'

const ONBOARD_URL = process.env.ONBOARD_URL || 'https://ens.goat.navy/'
const PDS_ENDPOINT = process.env.PDS_ENDPOINT || 'https://blue.goat.navy'
const ADMIN_PASSWORD = process.env.PDS_ADMIN_PASSWORD
const ACCOUNT_PASSWORD = process.env.PDS_ACCOUNT_PASSWORD
if (!ACCOUNT_PASSWORD) throw new Error('Set PDS_ACCOUNT_PASSWORD (shared test-account password)')
const SEED_PATH = process.env.SEED_PATH || `${process.env.HOME}/.config/onboard-test/seed.txt`
const subdomain = process.argv[2] || `test${Date.now().toString(36)}`

async function makeInviteCode() {
  if (!ADMIN_PASSWORD) throw new Error('This PDS requires an invite code - set PDS_ADMIN_PASSWORD (admin:PASSWORD Basic auth)')
  const res = await fetch(`${PDS_ENDPOINT}/xrpc/com.atproto.server.createInviteCode`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Basic ' + Buffer.from(`admin:${ADMIN_PASSWORD}`).toString('base64'),
    },
    body: JSON.stringify({ useCount: 1 }),
  })
  if (!res.ok) throw new Error(`createInviteCode failed: ${res.status} ${await res.text()}`)
  return (await res.json()).code
}

async function main() {
  const serverInfo = await fetch(`${PDS_ENDPOINT}/xrpc/com.atproto.server.describeServer`).then((r) => r.json())
  const inviteCode = serverInfo.inviteCodeRequired ? await makeInviteCode() : ''
  console.log(`handle domain(s) available: ${(serverInfo.availableUserDomains || []).join(', ')}`)
  console.log(`invite code: ${inviteCode || '(not required)'}`)

  const browser = await chromium.launch()
  const page = await browser.newPage()

  page.on('console', (msg) => console.log(`[console.${msg.type()}] ${msg.text()}`))
  page.on('pageerror', (err) => console.log(`[pageerror] ${err}`))

  await page.goto(ONBOARD_URL)

  // Generate Key tab is active by default. Restore the persistent seed rather
  // than generating a fresh key, so every test run uses the same rotation key
  // (handles still differ per run, so this doesn't collide across runs).
  const mnemonic = (await fs.readFile(SEED_PATH, 'utf8')).trim()
  await page.fill('#mnemonicInput', mnemonic)
  await page.click('#restoreBtn')
  // #didKeyText is populated on success by both the generate and restore
  // flows - a reliable signal the key actually loaded.
  await page.waitForSelector('#didKeyText:not(:empty)', { timeout: 10000, state: 'attached' })

  // Switch to Create Account tab
  await page.click('#createaccount-tab')

  await page.fill('#pds-endpoint', '')
  await page.fill('#pds-endpoint', PDS_ENDPOINT)
  await page.locator('#pds-endpoint').blur()

  // Whatever domain(s) this PDS actually offers - not assumed to be
  // .id.goat.navy, which is specific to blue.goat.navy's own setup.
  await page.waitForSelector('#account-handle-domain option:not([value=""])', { timeout: 10000, state: 'attached' })
  const handleDomain = await page.locator('#account-handle-domain option:not([value=""])').first().getAttribute('value')
  await page.selectOption('#account-handle-domain', handleDomain)
  // Mirrors the app's own subdomain+domain join logic (see the
  // createaccount-form submit handler): a domain starting with "." gets
  // concatenated directly, otherwise a "." is inserted.
  const handle = handleDomain.startsWith('.') ? `${subdomain}${handleDomain}` : `${subdomain}.${handleDomain}`
  console.log(`handle: ${handle}`)

  await page.fill('#account-handle-subdomain', subdomain)
  await page.fill('#account-email', `${subdomain}@test.invalid`)
  await page.fill('#account-password', ACCOUNT_PASSWORD)
  await page.fill('#account-invite-code', inviteCode)

  await page.click('#submit-createaccount-btn')

  const status = await page.waitForFunction(() => {
    const el = document.getElementById('status-line')
    if (!el) return null
    if (el.querySelector('.status.error')) return el.textContent || ''
    const text = el.textContent || ''
    if (/account created/i.test(text)) return text
    return null
  }, null, { timeout: 30000 }).then((h) => h.jsonValue())

  console.log('---')
  console.log('final status:', status)

  await browser.close()

  if (!/Account created/i.test(status)) {
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
