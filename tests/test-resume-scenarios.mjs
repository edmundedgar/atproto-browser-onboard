#!/usr/bin/env node
// Covers the new existence-check resume logic:
//   1. Fresh create (baseline - nothing should have regressed)
//   2. Same key + handle + PDS + correct password -> resumes cleanly
//   3. Same key + handle + PDS + wrong password -> clear "wrong password" error
//   4. Different key + same handle -> clear "handle taken by someone else" error

import { chromium } from 'playwright'
import fs from 'node:fs/promises'

const ONBOARD_URL = process.env.ONBOARD_URL || 'https://ens.goat.navy/'
const PDS_ENDPOINT = process.env.PDS_ENDPOINT || 'https://blue.goat.navy'
const ADMIN_PASSWORD = process.env.PDS_ADMIN_PASSWORD
if (!ADMIN_PASSWORD) throw new Error('Set PDS_ADMIN_PASSWORD (blue-pds admin password)')
const ACCOUNT_PASSWORD = process.env.PDS_ACCOUNT_PASSWORD
if (!ACCOUNT_PASSWORD) throw new Error('Set PDS_ACCOUNT_PASSWORD (shared test-account password)')
const SEED_PATH = process.env.SEED_PATH || `${process.env.HOME}/.config/onboard-test/seed.txt`
const subdomain = process.argv[2] || `resscen${Date.now().toString(36)}`

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

async function waitForFinalStatus(page, timeout = 30000) {
  return page.waitForFunction(() => {
    const el = document.getElementById('status-line')
    if (!el) return null
    if (el.querySelector('.status.error')) return el.textContent || ''
    const text = el.textContent || ''
    if (/account created/i.test(text)) return text
    return null
  }, null, { timeout }).then((h) => h.jsonValue())
}

async function fillAccountForm(page, { mnemonic, password, inviteCode }) {
  await page.goto(ONBOARD_URL)
  if (mnemonic) {
    await page.fill('#mnemonicInput', mnemonic)
    await page.click('#restoreBtn')
  } else {
    await page.click('#generateBtn')
  }
  await page.waitForSelector('#didKeyText:not(:empty)', { timeout: 10000, state: 'attached' })
  if (!mnemonic) {
    // A freshly generated (not restored) key gates the other tabs behind
    // the "I have written down this seed phrase" confirmation.
    await page.click('#confirmSeedBtn')
  }

  await page.click('#createaccount-tab')
  await page.fill('#pds-endpoint', '')
  await page.fill('#pds-endpoint', PDS_ENDPOINT)
  await page.locator('#pds-endpoint').blur()
  await page.waitForSelector('#account-handle-domain option[value=".id.goat.navy"]', { timeout: 10000, state: 'attached' })
  await page.selectOption('#account-handle-domain', '.id.goat.navy')
  await page.fill('#account-handle-subdomain', subdomain)
  await page.fill('#account-email', `${subdomain}@test.invalid`)
  await page.fill('#account-password', password)
  if (inviteCode) await page.fill('#account-invite-code', inviteCode)
}

async function main() {
  const mnemonic = (await fs.readFile(SEED_PATH, 'utf8')).trim()
  const browser = await chromium.launch()

  console.log(`handle: ${subdomain}.id.goat.navy`)

  // --- 1. Fresh create ---
  console.log('\n=== 1. Fresh create ===')
  const inviteCode1 = await makeInviteCode()
  const page1 = await browser.newPage()
  page1.on('pageerror', (err) => console.log(`[pageerror] ${err}`))
  await fillAccountForm(page1, { mnemonic, password: ACCOUNT_PASSWORD, inviteCode: inviteCode1 })
  await page1.click('#submit-createaccount-btn')
  const status1 = await waitForFinalStatus(page1)
  console.log('result:', status1)
  await page1.close()
  if (!/account created/i.test(status1)) throw new Error('Fresh create failed, aborting scenario tests')

  // --- 2. Resume: same key + handle + password ---
  console.log('\n=== 2. Resume with correct password ===')
  const page2 = await browser.newPage()
  page2.on('console', (msg) => {
    const t = msg.text()
    if (/existing|RepoNotFound|describeRepo|Login|reusing/i.test(t)) console.log(`[console] ${t}`)
  })
  page2.on('pageerror', (err) => console.log(`[pageerror] ${err}`))
  await fillAccountForm(page2, { mnemonic, password: ACCOUNT_PASSWORD })
  await page2.click('#submit-createaccount-btn')
  const status2 = await waitForFinalStatus(page2)
  console.log('result:', status2)
  await page2.close()

  // --- 3. Resume: same key + handle, WRONG password ---
  console.log('\n=== 3. Resume with wrong password ===')
  const page3 = await browser.newPage()
  page3.on('pageerror', (err) => console.log(`[pageerror] ${err}`))
  await fillAccountForm(page3, { mnemonic, password: 'definitely-the-wrong-password-123' })
  await page3.click('#submit-createaccount-btn')
  const status3 = await waitForFinalStatus(page3)
  console.log('result:', status3)
  await page3.close()

  // --- 4. Different key, same handle ---
  console.log('\n=== 4. Different key, same handle (should be rejected) ===')
  const page4 = await browser.newPage()
  page4.on('pageerror', (err) => console.log(`[pageerror] ${err}`))
  await fillAccountForm(page4, { password: ACCOUNT_PASSWORD }) // no mnemonic -> generates a fresh, different key
  await page4.click('#submit-createaccount-btn')
  const status4 = await waitForFinalStatus(page4)
  console.log('result:', status4)
  await page4.close()

  await browser.close()

  console.log('\n--- summary ---')
  console.log('1. fresh create:        ', status1)
  console.log('2. correct-password resume:', status2)
  console.log('3. wrong-password resume:  ', status3)
  console.log('4. different-key conflict: ', status4)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
