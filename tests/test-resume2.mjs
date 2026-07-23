#!/usr/bin/env node
// Simulates the gap the old reserveSigningKey-based flow couldn't recover
// from: createAccount succeeds, but the client dies before submitting the
// DID update. Blocks the second POST to plc.directory (the update - the
// first is the genesis record, which must succeed for this scenario).

import { chromium } from 'playwright'
import fs from 'node:fs/promises'

const ONBOARD_URL = process.env.ONBOARD_URL || 'https://ens.goat.navy/'
const PDS_ENDPOINT = process.env.PDS_ENDPOINT || 'https://blue.goat.navy'
const ADMIN_PASSWORD = process.env.PDS_ADMIN_PASSWORD
if (!ADMIN_PASSWORD) throw new Error('Set PDS_ADMIN_PASSWORD (blue-pds admin password)')
const ACCOUNT_PASSWORD = process.env.PDS_ACCOUNT_PASSWORD
if (!ACCOUNT_PASSWORD) throw new Error('Set PDS_ACCOUNT_PASSWORD (shared test-account password)')
const SEED_PATH = process.env.SEED_PATH || `${process.env.HOME}/.config/onboard-test/seed.txt`
const subdomain = process.argv[2] || `resume2-${Date.now().toString(36)}`

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

// Progress messages ("creating DID record...") use the same .status.success
// class as the true final state, so only .status.error is a reliable
// class-based signal - success still needs to match the actual final phrase.
async function waitForStatus(page) {
  return page.waitForFunction(() => {
    const el = document.getElementById('status-line')
    if (!el) return null
    if (el.querySelector('.status.error')) return el.textContent || ''
    const text = el.textContent || ''
    if (/account created/i.test(text)) return text
    return null
  }, null, { timeout: 30000 }).then((h) => h.jsonValue())
}

async function main() {
  const inviteCode = await makeInviteCode()
  console.log(`handle: ${subdomain}.id.goat.navy`)

  const browser = await chromium.launch()

  console.log('\n=== ATTEMPT 1: createAccount succeeds, DID update submission blocked ===')
  const page1 = await browser.newPage()
  let plcPostCount = 0
  await page1.route('https://plc.directory/**', (route) => {
    if (route.request().method() === 'POST') {
      plcPostCount++
      if (plcPostCount === 2) {
        console.log('[intercepted] blocking the 2nd plc.directory POST (the DID update)')
        return route.abort('connectionrefused')
      }
    }
    return route.continue()
  })
  page1.on('console', (msg) => {
    const text = msg.text()
    if (/Account creation successful|error|Submitting DID:PLC Operation/i.test(text)) console.log(`[p1] ${text}`)
  })
  await fillForm(page1, inviteCode)
  await page1.click('#submit-createaccount-btn')
  const status1 = await waitForStatus(page1)
  console.log('attempt 1 final status:', status1)
  await page1.close()

  console.log('\n=== ATTEMPT 2: plain retry, no blocking ===')
  const page2 = await browser.newPage()
  page2.on('console', (msg) => {
    const text = msg.text()
    if (/already exist|Reusing|reusing|Creating account|Account creation|already submitted|Activating|activated|Warning/i.test(text)) {
      console.log(`[p2] ${text}`)
    }
  })
  await fillForm(page2, inviteCode)
  await page2.click('#submit-createaccount-btn')
  const status2 = await waitForStatus(page2)
  console.log('attempt 2 final status:', status2)
  await page2.close()

  await browser.close()

  if (!/Account created/i.test(status2)) {
    console.error('FAIL: retry did not succeed')
    process.exit(1)
  }
  console.log('\nPASS')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
