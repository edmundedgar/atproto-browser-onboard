#!/usr/bin/env node
// Drives a real OAuth login through take control's doPlcCosign path - the one
// purpose family (take-control/final-cosign/update-rotation-keys) that
// test-oauth-handle-change.mjs doesn't exercise, since it shows an in-popup
// form for an emailed confirmation code instead of completing in one shot.
//
// Reads that code straight out of the reference PDS's own SQLite database
// instead of an inbox - we run blue.goat.navy ourselves, and its account.sqlite
// has a plain "email_token" table (purpose, did, token, requestedAt) that
// requestPlcOperationSignature writes to before the popup ever shows the
// form, so it's already there by the time we need it. tranquil.goat.navy
// can't be substituted here - its confirmation tokens live in an in-process
// cache (see tranquil-cache's "ripple" backend), not anywhere queryable from
// outside the process.
//
// The account under test is created directly via a raw createAccount XRPC
// call, not through this app's own create-account tab - that matters because
// this app's create-account flow pre-registers the browser's self-custody key
// as the DID's only rotation key, which would make "take control" a no-op
// (already held, so runMigrateTakeControl's popup path never triggers). A
// plain createAccount call leaves the PDS's own key as the only rotation key,
// same as a signup on any ordinary client - exactly the case take-control
// exists for.
//
// Usage: node test-oauth-plc-cosign.mjs [test-label]

import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const ONBOARD_URL = process.env.ONBOARD_URL || 'https://ens.goat.navy/'
const PDS_ENDPOINT = process.env.PDS_ENDPOINT || 'https://blue.goat.navy'
const ADMIN_PASSWORD = process.env.PDS_ADMIN_PASSWORD
if (!ADMIN_PASSWORD) throw new Error('Set PDS_ADMIN_PASSWORD (admin:PASSWORD Basic auth)')
const ACCOUNT_PASSWORD = process.env.PDS_ACCOUNT_PASSWORD
if (!ACCOUNT_PASSWORD) throw new Error('Set PDS_ACCOUNT_PASSWORD (shared test-account password)')
const SEED_PATH = process.env.SEED_PATH || `${process.env.HOME}/.config/onboard-test/seed.txt`
// Only meaningful against blue.goat.navy - see the file header comment.
const ACCOUNT_SQLITE_PATH = process.env.ACCOUNT_SQLITE_PATH || `${process.env.HOME}/.local/share/blue-pds/data/account.sqlite`

const testLabel = process.argv[2] || `plccosign${Date.now().toString(36)}`

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

async function createVanillaAccount(handle) {
  const inviteCode = await makeInviteCode()
  const res = await fetch(`${PDS_ENDPOINT}/xrpc/com.atproto.server.createAccount`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // No `did` field - the PDS mints its own did:plc genesis operation with
    // its own key as the sole rotation key, unlike this app's own
    // create-account flow.
    body: JSON.stringify({ handle, email: `${handle.split('.')[0]}@test.invalid`, password: ACCOUNT_PASSWORD, inviteCode }),
  })
  if (!res.ok) throw new Error(`createAccount failed: ${res.status} ${await res.text()}`)
  return res.json()
}

async function readPlcOperationToken(did) {
  const { stdout } = await execFileAsync('sqlite3', [
    ACCOUNT_SQLITE_PATH,
    `SELECT token FROM email_token WHERE purpose='plc_operation' AND did='${did}';`,
  ])
  const token = stdout.trim()
  if (!token) throw new Error(`No plc_operation email token found for ${did} in ${ACCOUNT_SQLITE_PATH}`)
  return token
}

async function main() {
  const subdomain = testLabel
  const handle = `${subdomain}.id.goat.navy`
  const { did } = await createVanillaAccount(handle)
  console.log(`vanilla account created: ${handle} (${did}), rotation key is the PDS's own`)

  const browser = await chromium.launch()
  const page = await browser.newPage()
  page.on('console', (msg) => console.log(`[page.${msg.type()}] ${msg.text()}`))
  page.on('pageerror', (err) => console.log(`[page pageerror] ${err}`))

  await page.goto(ONBOARD_URL)

  const mnemonic = (await fs.readFile(SEED_PATH, 'utf8')).trim()
  await page.fill('#mnemonicInput', mnemonic)
  await page.click('#restoreBtn')
  await page.waitForSelector('#didKeyText:not(:empty)', { timeout: 10000, state: 'attached' })

  // --- Find the vanilla account and select it (DNS TXT record for its
  // handle needs the sync timer to publish it first, so retry) ---
  await page.click('#createaccount-tab')
  await page.click('#account-list-subtab')

  let found = false
  for (let attempt = 0; attempt < 15 && !found; attempt++) {
    if (attempt > 0) await page.waitForTimeout(3000)
    await page.fill('#account-find-handle', handle)
    await page.click('#account-find-btn')
    try {
      await page.waitForFunction(
        (h) => {
          const status = document.getElementById('account-find-status')
          return status && status.textContent.trim() === '' // cleared on success
        },
        handle,
        { timeout: 4000 },
      )
      found = true
    } catch {
      const statusText = (await page.locator('#account-find-status').textContent().catch(() => '')) || ''
      console.log(`Account not resolvable yet (attempt ${attempt + 1}): ${statusText.trim()}`)
    }
  }
  if (!found) throw new Error('Could not resolve the vanilla account by handle - DNS TXT record never propagated')
  console.log('vanilla account found and selected')

  // --- Migrate tab: should offer "take control" since our self-custody key
  // isn't a rotation key on this account yet ---
  await page.click('#migrate-tab')
  await page.waitForSelector('#migrate-take-control-btn', { timeout: 15000 })
  console.log('Migrate tab confirms the held key is not yet registered - take-control button shown')

  const [oauthPopup] = await Promise.all([
    page.waitForEvent('popup'),
    page.click('#migrate-take-control-btn'),
  ])
  oauthPopup.on('console', (msg) => console.log(`[oauth.${msg.type()}] ${msg.text()}`))
  oauthPopup.on('pageerror', (err) => console.log(`[oauth pageerror] ${err}`))

  const usernameField = oauthPopup.locator('#username, input[name="username"]').first()
  await usernameField.waitFor({ timeout: 20000 })
  console.log('reached the PDS\'s real OAuth login page')

  if (await usernameField.isEditable()) {
    await usernameField.fill(handle)
  } else {
    const usernameValue = await usernameField.inputValue()
    if (usernameValue !== handle) throw new Error(`login_hint prefilled "${usernameValue}", expected "${handle}"`)
  }
  await oauthPopup.locator('#password, input[name="password"]').first().fill(ACCOUNT_PASSWORD)
  await oauthPopup.getByRole('button', { name: /sign in/i }).click()
  await oauthPopup.getByRole('button', { name: /^authorize$/i }).click({ timeout: 20000 })
  console.log('signed in and authorized on the real OAuth consent page')

  // --- doPlcCosign's in-popup confirmation-code form ---
  await oauthPopup.locator('#plc-token-input').waitFor({ timeout: 20000 })
  console.log('popup is showing the email-confirmation-code form - requestPlcOperationSignature already ran')

  const token = await readPlcOperationToken(did)
  console.log(`read confirmation token straight out of ${ACCOUNT_SQLITE_PATH}: ${token}`)

  await oauthPopup.locator('#plc-token-input').fill(token)
  await oauthPopup.locator('#plc-token-submit').click()

  // --- Back on the main page: take-control should now report success ---
  await page.waitForSelector('#migrate-take-control-status .migrate-status-box.success', { timeout: 20000 })
  const finalStatus = (await page.locator('#migrate-take-control-status .migrate-status-box.success').textContent()).trim()
  console.log('take-control succeeded:', finalStatus)

  // Independently verify against plc.directory itself, not just this app's
  // own UI - fetch the DID document and confirm our own did:key is now one
  // of the rotation keys.
  const ourDidKey = await page.locator('#didKeyText').textContent()
  const auditLog = await fetch(`https://plc.directory/${did}/log/audit`).then((r) => r.json())
  const latestOp = auditLog[auditLog.length - 1].operation
  if (!(latestOp.rotationKeys || []).includes(ourDidKey.trim())) {
    throw new Error(`plc.directory's latest operation for ${did} does not list our key ${ourDidKey} as a rotation key: ${JSON.stringify(latestOp.rotationKeys)}`)
  }
  console.log(`plc.directory confirms our key is now a rotation key on ${did}`)

  await browser.close()
  console.log('--- PASS ---')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
