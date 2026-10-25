#!/usr/bin/env node
// vlpds port of test-oauth-handle-change.mjs. Domain selection here was
// already PDS-agnostic (dynamic) in the original. The only change is the
// OAuth login/consent selectors: vlpds's own OAuth login page uses
// #identifier (not #username) and name/value-attribute buttons rather than
// role+text matches (discovered porting test-oauth-plc-cosign.mjs).
//
// Drives a real OAuth login through the PDS's own hosted authorization page
// (not this app's UI - a separate app the PDS itself serves) to change a
// freshly created account's handle via the Handle tab.
//
// Usage: node test-oauth-handle-change-vlpds.mjs [test-label]

import { chromium } from 'playwright'
import fs from 'node:fs/promises'

const ONBOARD_URL = process.env.ONBOARD_URL || 'https://ens.goat.navy/'
const PDS_ENDPOINT = process.env.PDS_ENDPOINT || 'https://vlpds.goat.navy'
const ADMIN_PASSWORD = process.env.PDS_ADMIN_PASSWORD
const ACCOUNT_PASSWORD = process.env.PDS_ACCOUNT_PASSWORD
if (!ACCOUNT_PASSWORD) throw new Error('Set PDS_ACCOUNT_PASSWORD (shared test-account password)')
const SEED_PATH = process.env.SEED_PATH || `${process.env.HOME}/.config/onboard-test/seed.txt`

const testLabel = process.argv[2] || `pwoauth${Date.now().toString(36)}`

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

async function waitForAccountCreated(page) {
  const status = await page.waitForFunction(() => {
    const el = document.getElementById('status-line')
    if (!el) return null
    if (el.querySelector('.status.error')) return el.textContent || ''
    const text = el.textContent || ''
    if (/account created/i.test(text)) return text
    return null
  }, null, { timeout: 30000 }).then((h) => h.jsonValue())
  if (!/account created/i.test(status)) throw new Error(`Account creation did not succeed: ${status}`)
}

async function main() {
  const serverInfo = await fetch(`${PDS_ENDPOINT}/xrpc/com.atproto.server.describeServer`).then((r) => r.json())
  const inviteCode = serverInfo.inviteCodeRequired ? await makeInviteCode() : ''
  console.log(`test label: ${testLabel}`)

  const browser = await chromium.launch()
  const page = await browser.newPage()
  page.on('console', (msg) => console.log(`[page.${msg.type()}] ${msg.text()}`))
  page.on('pageerror', (err) => console.log(`[page pageerror] ${err}`))

  await page.goto(ONBOARD_URL)

  const mnemonic = (await fs.readFile(SEED_PATH, 'utf8')).trim()
  await page.fill('#mnemonicInput', mnemonic)
  await page.click('#restoreBtn')
  await page.waitForSelector('#didKeyText:not(:empty)', { timeout: 10000, state: 'attached' })

  // --- Create the account we'll change the handle of ---
  await page.click('#createaccount-tab')
  await page.fill('#pds-endpoint', '')
  await page.fill('#pds-endpoint', PDS_ENDPOINT)
  await page.locator('#pds-endpoint').blur()
  await page.waitForSelector('#account-handle-domain option:not([value=""])', { timeout: 10000, state: 'attached' })
  const handleDomain = await page.locator('#account-handle-domain option:not([value=""])').first().getAttribute('value')
  await page.selectOption('#account-handle-domain', handleDomain)

  const originalSubdomain = testLabel
  const originalHandle = handleDomain.startsWith('.') ? `${originalSubdomain}${handleDomain}` : `${originalSubdomain}.${handleDomain}`
  await page.fill('#account-handle-subdomain', originalSubdomain)
  await page.fill('#account-email', `${originalSubdomain}@test.invalid`)
  await page.fill('#account-password', ACCOUNT_PASSWORD)
  await page.fill('#account-invite-code', inviteCode)
  await page.click('#submit-createaccount-btn')
  await waitForAccountCreated(page)
  console.log(`account created: ${originalHandle}`)

  // --- Handle tab: pick a new handle on the same PDS domain ---
  let handleTabReady = false
  for (let attempt = 0; attempt < 10 && !handleTabReady; attempt++) {
    if (attempt > 0) {
      await page.click('#createaccount-tab')
      await page.waitForTimeout(3000)
    }
    await page.click('#handle-tab')
    try {
      await page.waitForSelector('#handle-new-domain option[value="__custom__"]', { timeout: 5000, state: 'attached' })
      handleTabReady = true
    } catch {
      const lookupStatus = (await page.locator('#handle-lookup-status').textContent().catch(() => '')) || ''
      console.log(`Handle tab not ready yet (attempt ${attempt + 1}): ${lookupStatus.trim()}`)
    }
  }
  if (!handleTabReady) throw new Error('Handle tab never became ready - own-handle DNS resolution kept failing')

  const newSubdomain = `${originalSubdomain}b`
  const newHandle = handleDomain.startsWith('.') ? `${newSubdomain}${handleDomain}` : `${newSubdomain}.${handleDomain}`
  await page.selectOption('#handle-new-domain', handleDomain)
  await page.fill('#handle-new-subdomain', newSubdomain)

  // Plain PDS domain needs no setup/check step - the button should already
  // be enabled once both fields have a value.
  await page.waitForFunction(() => {
    const btn = document.getElementById('handle-change-btn')
    return btn && !btn.disabled
  }, null, { timeout: 5000 })

  // --- Click through to the real OAuth login ---
  const [oauthPopup] = await Promise.all([
    page.waitForEvent('popup'),
    page.click('#handle-change-btn'),
  ])
  oauthPopup.on('console', (msg) => console.log(`[oauth.${msg.type()}] ${msg.text()}`))
  oauthPopup.on('pageerror', (err) => console.log(`[oauth pageerror] ${err}`))

  // vlpds's own OAuth login page uses #identifier, not #username.
  const usernameField = oauthPopup.locator('#identifier, input[name="username"]').first()
  await usernameField.waitFor({ timeout: 20000 })
  console.log('reached the PDS\'s real OAuth login page - PAR/client-metadata.json accepted')

  // login_hint (set from the account's current handle) pre-fills and locks
  // the username field on implementations that support it - only fill it
  // in ourselves if it's actually editable.
  if (await usernameField.isEditable()) {
    await usernameField.fill(originalHandle)
  } else {
    const usernameValue = await usernameField.inputValue()
    if (usernameValue !== originalHandle) throw new Error(`login_hint prefilled "${usernameValue}", expected "${originalHandle}"`)
  }
  await oauthPopup.locator('#password, input[name="password"]').first().fill(ACCOUNT_PASSWORD)
  await oauthPopup.locator('button[name="action"][value="sign-in"]').click()

  await oauthPopup.locator('button[name="action"][value="allow"]').click({ timeout: 20000 })
  console.log('signed in and authorized on the real OAuth consent page')

  // Back on the main page: the popup should close itself once the handle
  // change finishes, and the status should report success.
  // The Handle tab uses migrateStatusBlock's .migrate-status-box.success
  // convention, not the .status.success one create-account/domain.html use.
  await page.waitForSelector('#handle-change-status .migrate-status-box.success', { timeout: 30000 })
  const finalStatus = (await page.locator('#handle-change-status .migrate-status-box.success').textContent()).trim()
  if (!finalStatus.includes(newHandle)) throw new Error(`Unexpected success text: "${finalStatus}"`)
  console.log('handle change succeeded:', finalStatus)

  // Confirm the PDS itself now reports the new handle - handleIsCorrect
  // does its own DNS TXT verification (same as any atproto handle, even
  // one on the PDS's own service domain), so give the just-published
  // _atproto record a few seconds to propagate.
  let handleIsCorrect = false
  for (let attempt = 0; attempt < 10 && !handleIsCorrect; attempt++) {
    const describeRes = await fetch(`${PDS_ENDPOINT}/xrpc/com.atproto.repo.describeRepo?repo=${encodeURIComponent(newHandle)}`)
    if (!describeRes.ok) throw new Error(`describeRepo for the new handle failed: ${describeRes.status}`)
    const describeBody = await describeRes.json()
    handleIsCorrect = !!describeBody.handleIsCorrect
    if (!handleIsCorrect) await new Promise((r) => setTimeout(r, 2000))
  }
  if (!handleIsCorrect) throw new Error(`PDS still does not consider "${newHandle}" the correct handle after retrying`)
  console.log(`PDS confirms handleIsCorrect for ${newHandle}`)

  await browser.close()
  console.log('--- PASS ---')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
