#!/usr/bin/env node
// Drives the real onboarding flow (generate key -> create DID:PLC -> createAccount
// -> submit DID update -> activateAccount) against a live ens.goat.navy + blue-pds,
// using a real headless browser so the page's own JS runs unmodified.
//
// Usage: node test-onboard.mjs [handle-subdomain]

import { chromium } from 'playwright'
import fs from 'node:fs/promises'

const ONBOARD_URL = process.env.ONBOARD_URL || 'https://ens.goat.navy/'
const PDS_ENDPOINT = process.env.PDS_ENDPOINT || 'https://blue.goat.navy'
const ADMIN_PASSWORD = process.env.PDS_ADMIN_PASSWORD
if (!ADMIN_PASSWORD) throw new Error('Set PDS_ADMIN_PASSWORD (blue-pds admin password)')
const ACCOUNT_PASSWORD = process.env.PDS_ACCOUNT_PASSWORD
if (!ACCOUNT_PASSWORD) throw new Error('Set PDS_ACCOUNT_PASSWORD (shared test-account password)')
const SEED_PATH = process.env.SEED_PATH || `${process.env.HOME}/.config/onboard-test/seed.txt`
const subdomain = process.argv[2] || `test${Date.now().toString(36)}`

async function makeInviteCode() {
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
  const inviteCode = await makeInviteCode()
  console.log(`handle: ${subdomain}.id.goat.navy`)
  console.log(`invite code: ${inviteCode}`)

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
  // #keyDisplay doesn't actually exist in the DOM (pre-existing bug in the
  // page - every getElementById('keyDisplay') is a silent no-op), so use
  // #didKeyText instead, which is a real element populated on success by
  // both the generate and restore flows.
  await page.waitForSelector('#didKeyText:not(:empty)', { timeout: 10000, state: 'attached' })

  // Switch to Create Account tab
  await page.click('#createaccount-tab')

  await page.fill('#pds-endpoint', '')
  await page.fill('#pds-endpoint', PDS_ENDPOINT)
  await page.locator('#pds-endpoint').blur()

  await page.waitForSelector('#account-handle-domain option[value=".id.goat.navy"]', { timeout: 10000, state: 'attached' })
  await page.selectOption('#account-handle-domain', '.id.goat.navy')

  await page.fill('#account-handle-subdomain', subdomain)
  await page.fill('#account-email', `${subdomain}@test.invalid`)
  await page.fill('#account-password', ACCOUNT_PASSWORD)
  await page.fill('#account-invite-code', inviteCode)

  await page.click('#submit-createaccount-btn')

  const status = await page.waitForFunction(() => {
    const el = document.querySelector('#createaccount-pane .status, .tab-pane.active .status')
    if (!el) return null
    const text = el.textContent || ''
    if (/successfully|error/i.test(text)) return text
    return null
  }, null, { timeout: 30000 }).then((h) => h.jsonValue())

  console.log('---')
  console.log('final status:', status)

  await browser.close()

  if (!/successfully/i.test(status)) {
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
