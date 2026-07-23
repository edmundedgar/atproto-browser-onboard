#!/usr/bin/env node
// Simulates: DID:PLC genesis record gets created, then the PDS becomes
// unreachable right as createAccount is attempted. Confirms the flow fails
// cleanly at that point, then confirms a plain retry (no blocking) picks up
// from the DID that already exists and completes successfully.

import { chromium } from 'playwright'
import fs from 'node:fs/promises'

const ONBOARD_URL = process.env.ONBOARD_URL || 'https://ens.goat.navy/'
const PDS_ENDPOINT = process.env.PDS_ENDPOINT || 'https://blue.goat.navy'
const ADMIN_PASSWORD = process.env.PDS_ADMIN_PASSWORD
if (!ADMIN_PASSWORD) throw new Error('Set PDS_ADMIN_PASSWORD (blue-pds admin password)')
const ACCOUNT_PASSWORD = process.env.PDS_ACCOUNT_PASSWORD
if (!ACCOUNT_PASSWORD) throw new Error('Set PDS_ACCOUNT_PASSWORD (shared test-account password)')
const SEED_PATH = process.env.SEED_PATH || `${process.env.HOME}/.config/onboard-test/seed.txt`
const subdomain = process.argv[2] || `resume${Date.now().toString(36)}`

async function makeInviteCode() {
  const res = await fetch(`${PDS_ENDPOINT}/xrpc/com.atproto.server.createInviteCode`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Basic ' + Buffer.from(`admin:${ADMIN_PASSWORD}`).toString('base64'),
    },
    body: JSON.stringify({ useCount: 2 }),
  })
  if (!res.ok) throw new Error(`createInviteCode failed: ${res.status} ${await res.text()}`)
  return (await res.json()).code
}

async function fillForm(page, inviteCode) {
  const mnemonic = (await fs.readFile(SEED_PATH, 'utf8')).trim()
  await page.goto(ONBOARD_URL)
  await page.fill('#mnemonicInput', mnemonic)
  await page.click('#restoreBtn')
  await page.waitForSelector('#didKeyText:not(:empty)', { timeout: 10000, state: 'attached' })

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
}

async function waitForStatus(page) {
  return page.waitForFunction(() => {
    const el = document.querySelector('#createaccount-pane .status, .tab-pane.active .status')
    if (!el) return null
    const text = el.textContent || ''
    if (/successfully|error/i.test(text)) return text
    return null
  }, null, { timeout: 30000 }).then((h) => h.jsonValue())
}

async function main() {
  const inviteCode = await makeInviteCode()
  console.log(`handle: ${subdomain}.id.goat.navy`)

  const browser = await chromium.launch()

  // --- Attempt 1: block createAccount to simulate the PDS being down ---
  console.log('\n=== ATTEMPT 1: createAccount blocked (simulated PDS outage) ===')
  const page1 = await browser.newPage()
  page1.on('console', (msg) => {
    const text = msg.text()
    if (/DID:PLC|already exist|Creating account|Account creation|error/i.test(text)) {
      console.log(`[p1 console] ${text}`)
    }
  })
  await page1.route('**/xrpc/com.atproto.server.createAccount', (route) => route.abort('connectionrefused'))
  await fillForm(page1, inviteCode)
  await page1.click('#submit-createaccount-btn')
  const status1 = await waitForStatus(page1)
  console.log('attempt 1 final status:', status1)
  await page1.close()

  // --- Attempt 2: no blocking, plain retry ---
  console.log('\n=== ATTEMPT 2: plain retry, no blocking ===')
  const page2 = await browser.newPage()
  page2.on('console', (msg) => {
    const text = msg.text()
    if (/DID:PLC|already exist|Creating account|Account creation|Activating|activated|Warning/i.test(text)) {
      console.log(`[p2 console] ${text}`)
    }
  })
  await fillForm(page2, inviteCode)
  await page2.click('#submit-createaccount-btn')
  const status2 = await waitForStatus(page2)
  console.log('attempt 2 final status:', status2)
  await page2.close()

  await browser.close()

  if (!/successfully/i.test(status2)) {
    console.error('FAIL: retry did not succeed')
    process.exit(1)
  }
  console.log('\nPASS')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
