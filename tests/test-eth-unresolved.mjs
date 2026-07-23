#!/usr/bin/env node
// Tests whether the PDS itself requires a .eth.link handle to already
// resolve via .well-known/atproto-did before createAccount will succeed,
// or whether that's purely a client-side UI gate. Bypasses the submit
// button's disabled state (which the app sets deliberately while polling
// hasn't confirmed resolution) to find out what the PDS actually does.

import { chromium } from 'playwright'
import fs from 'node:fs/promises'

const ONBOARD_URL = process.env.ONBOARD_URL || 'https://ens.goat.navy/'
const PDS_ENDPOINT = process.env.PDS_ENDPOINT || 'https://blue.goat.navy'
const ADMIN_PASSWORD = process.env.PDS_ADMIN_PASSWORD
if (!ADMIN_PASSWORD) throw new Error('Set PDS_ADMIN_PASSWORD')
const ACCOUNT_PASSWORD = process.env.PDS_ACCOUNT_PASSWORD
if (!ACCOUNT_PASSWORD) throw new Error('Set PDS_ACCOUNT_PASSWORD')
const SEED_PATH = process.env.SEED_PATH || `${process.env.HOME}/.config/onboard-test/seed.txt`
const subdomain = process.argv[2] || `ethtest${Date.now().toString(36)}`

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
  const handle = `${subdomain}.eth.link`
  console.log(`handle: ${handle} (will never actually resolve)`)

  const browser = await chromium.launch()
  const page = await browser.newPage()
  page.on('console', (msg) => console.log(`[console.${msg.type()}] ${msg.text()}`))
  page.on('pageerror', (err) => console.log(`[pageerror] ${err}`))

  await page.goto(ONBOARD_URL)
  const mnemonic = (await fs.readFile(SEED_PATH, 'utf8')).trim()
  await page.fill('#mnemonicInput', mnemonic)
  await page.click('#restoreBtn')
  await page.waitForSelector('#didKeyText:not(:empty)', { timeout: 10000, state: 'attached' })

  await page.click('#createaccount-tab')
  await page.fill('#pds-endpoint', '')
  await page.fill('#pds-endpoint', PDS_ENDPOINT)
  await page.locator('#pds-endpoint').blur()
  await page.waitForSelector('#account-handle-domain option[value=".eth.link"]', { timeout: 10000, state: 'attached' })
  await page.selectOption('#account-handle-domain', '.eth.link')

  const disabledByGate = await page.locator('#submit-createaccount-btn').isDisabled()
  console.log('submit button disabled by the .eth.link gate:', disabledByGate)

  // Bypass the app's own UI gate to see what the PDS itself does.
  await page.evaluate(() => {
    document.getElementById('submit-createaccount-btn').disabled = false
  })

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

  // If it succeeded, check what the PDS itself reports about the handle.
  if (/account created/i.test(status)) {
    const describeRes = await fetch(`${PDS_ENDPOINT}/xrpc/com.atproto.repo.describeRepo?repo=${handle}`)
    const describeBody = await describeRes.json()
    console.log('describeRepo handleIsCorrect:', describeBody.handleIsCorrect)
  }

  await browser.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
