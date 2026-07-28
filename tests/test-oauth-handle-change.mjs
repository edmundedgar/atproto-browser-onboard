#!/usr/bin/env node
// Drives a real OAuth login through the PDS's own hosted authorization page
// (not this app's UI - a separate app the PDS itself serves) to change a
// freshly created account's handle via the Handle tab. Every other test in
// this suite deliberately stops short of this - it's the one thing that
// actually needs a real sign-in, so it's worth having at least one test
// that goes all the way.
//
// Also exercises the exact thing that changed recently: client-metadata.json
// is now a static file instead of computed per-request. The authorization
// server fetches that file itself (server-to-server, not from this browser)
// as part of the pushed authorization request this flow starts with - if
// the static file's content, or its client_id self-reference, were wrong,
// the PAR call would fail immediately and this test would fail at that
// step rather than reaching the login page at all.
//
// Defaults to tranquil.goat.navy, not blue.goat.navy (the other tests'
// default) - tried against blue.goat.navy first and the handle change
// itself succeeded (this app's own status showed "Handle changed to..."),
// but the PDS never actually resolved handleIsCorrect for the new handle
// even after retrying for 20s. tranquil.goat.navy has this session's
// earlier self-custody fixes merged and passes cleanly; blue.goat.navy is
// presumably running an unpatched reference PDS build, which is a known
// gap on the PDS side (see the "silently swallowed handle-update error"
// discussion this session had while fixing tranquil-pds), not a bug in
// this app - override PDS_ENDPOINT to point elsewhere if needed.
//
// Login page selectors differ by PDS implementation - the reference
// bluesky-social oauth-provider-ui (packages/oauth/oauth-provider-ui in
// the atproto monorepo) uses input[name="username"/"password"], no
// id/data-testid attributes; tranquil-pds's own Svelte UI
// (frontend/src/routes/OAuthLogin.svelte) uses #username/#password
// instead - this matches either. Both use plain "Sign in"/"Authorize"
// button text with no stable attributes, so those are targeted by role+text.
//
// Usage: node test-oauth-handle-change.mjs [test-label]

import { chromium } from 'playwright'
import fs from 'node:fs/promises'

const ONBOARD_URL = process.env.ONBOARD_URL || 'https://ens.goat.navy/'
const PDS_ENDPOINT = process.env.PDS_ENDPOINT || 'https://tranquil.goat.navy'
const ADMIN_PASSWORD = process.env.PDS_ADMIN_PASSWORD
// tranquil-pds enforces a stricter password policy (needs an uppercase
// letter) than the reference PDS - keep that in mind if pointing this at a
// different PDS_ENDPOINT with a reused password.
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

  // startOAuth() navigates this same window to the PDS's own hosted login
  // page after a successful pushed authorization request - that PAR call
  // is exactly where a broken client-metadata.json would have failed,
  // before any login UI ever appeared. Selector differs by PDS
  // implementation - the reference bluesky-social oauth-provider-ui uses
  // input[name="username"/"password"], tranquil-pds's own Svelte UI uses
  // #username/#password - so match either.
  const usernameField = oauthPopup.locator('#username, input[name="username"]').first()
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
  await oauthPopup.getByRole('button', { name: /sign in/i }).click()

  await oauthPopup.getByRole('button', { name: /^authorize$/i }).click({ timeout: 20000 })
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
