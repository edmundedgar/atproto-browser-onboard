#!/usr/bin/env node
// vlpds port of test-oauth-plc-cosign.mjs. Same flow (drive take control's
// doPlcCosign path through a real OAuth login), ported because vlpds can't
// supply the confirmation code the same way blue.goat.navy's version does:
//
// - No invite code: vlpds's describeServer reports inviteCodeRequired:false,
//   so skip blue's makeInviteCode() step entirely.
// - No SQLite: vlpds's LogMailer deliberately never logs a token or body at
//   any level ("they are credentials" - src/xrpc/server.rs). Instead it has
//   GET /xrpc/vlpds.admin.getDevMail?email=<email> (admin Basic auth, same
//   admin:PASSWORD scheme as blue), gated behind --dev-mode. The live
//   instance was restarted with --dev-mode (run-vlpds-devmode.sh) just for
//   this test run - restart back to run-vlpds.sh (no dev-mode) afterward.
// - No handle resolution: vlpds's own handle domain (*.vlpds.goat.navy) has
//   no wildcard DNS record, so a vlpds-hosted handle won't resolve via the
//   app's resolveHandleToDid. Use .id.goat.navy instead (a zone we already
//   run for exactly this "externally resolvable test handle" purpose) and
//   publish one record for this test handle via the existing safe helper
//   /usr/local/bin/add-atproto-txt.sh, right after createAccount - no need
//   for (and no touching of) the stopped atproto-txt-sync-blue-pds timer.
//
// Usage: node test-oauth-plc-cosign-vlpds.mjs [test-label]

import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const ONBOARD_URL = process.env.ONBOARD_URL || 'https://ens.goat.navy/'
const PDS_ENDPOINT = process.env.PDS_ENDPOINT || 'https://vlpds.goat.navy'
const ADMIN_PASSWORD = process.env.PDS_ADMIN_PASSWORD
if (!ADMIN_PASSWORD) throw new Error('Set PDS_ADMIN_PASSWORD (admin:PASSWORD Basic auth, vlpds --admin-token)')
const ACCOUNT_PASSWORD = process.env.PDS_ACCOUNT_PASSWORD
if (!ACCOUNT_PASSWORD) throw new Error('Set PDS_ACCOUNT_PASSWORD (shared test-account password)')
const SEED_PATH = process.env.SEED_PATH || `${process.env.HOME}/.config/onboard-test/seed.txt`

const testLabel = process.argv[2] || `plccosignv${Date.now().toString(36)}`

async function createVanillaAccount(handle, email) {
  const res = await fetch(`${PDS_ENDPOINT}/xrpc/com.atproto.server.createAccount`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // No `did` field - vlpds mints its own did:plc genesis operation with
    // its own key as the sole rotation key, unlike this app's own
    // create-account flow.
    body: JSON.stringify({ handle, email, password: ACCOUNT_PASSWORD }),
  })
  if (!res.ok) throw new Error(`createAccount failed: ${res.status} ${await res.text()}`)
  return res.json()
}

async function publishIdGoatNavyTxt(handle, did) {
  const { stdout, stderr } = await execFileAsync('/usr/local/bin/add-atproto-txt.sh', [handle, did])
  console.log(`published _atproto.${handle} TXT record: ${stdout.trim()}${stderr.trim()}`)
}

// vlpds only accepts its own --handle-domain at createAccount, so the
// .id.goat.navy handle has to be adopted afterward via the standard
// updateHandle mechanism (same as the app's real "custom domain" feature) -
// once the TXT record resolves, vlpds verifies it and makes it the
// account's real handle, which is what the migrate tab re-derives from the
// DID doc downstream (not whatever string was typed into account-find).
async function adoptIdGoatNavyHandle(accessJwt, lookupHandle) {
  const res = await fetch(`${PDS_ENDPOINT}/xrpc/com.atproto.identity.updateHandle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessJwt}` },
    body: JSON.stringify({ handle: lookupHandle }),
  })
  if (!res.ok) throw new Error(`updateHandle failed: ${res.status} ${await res.text()}`)
}

async function readPlcOperationToken(email) {
  const res = await fetch(`${PDS_ENDPOINT}/xrpc/vlpds.admin.getDevMail?${new URLSearchParams({ email })}`, {
    headers: { Authorization: 'Basic ' + Buffer.from(`admin:${ADMIN_PASSWORD}`).toString('base64') },
  })
  if (!res.ok) throw new Error(`getDevMail failed: ${res.status} ${await res.text()}`)
  const { token } = await res.json()
  if (!token) throw new Error(`No plc_operation token in getDevMail response for ${email}`)
  return token
}

async function main() {
  const subdomain = testLabel
  // vlpds only accepts handles under its own --handle-domain; .id.goat.navy
  // is purely an externally-resolvable alias for the app's account-lookup
  // step (DNS TXT), decoupled from the account's real registered handle.
  const handle = `${subdomain}.vlpds.goat.navy`
  const lookupHandle = `${subdomain}.id.goat.navy`
  const email = `${subdomain}@test.invalid`
  const { did, accessJwt } = await createVanillaAccount(handle, email)
  console.log(`vanilla account created: ${handle} (${did}), rotation key is vlpds's own`)

  await publishIdGoatNavyTxt(lookupHandle, did)
  await adoptIdGoatNavyHandle(accessJwt, lookupHandle)
  console.log(`adopted ${lookupHandle} as the account's real handle`)

  const browser = await chromium.launch()
  const page = await browser.newPage()
  page.on('console', (msg) => console.log(`[page.${msg.type()}] ${msg.text()}`))
  page.on('pageerror', (err) => console.log(`[page pageerror] ${err}`))

  await page.goto(ONBOARD_URL)

  const mnemonic = (await fs.readFile(SEED_PATH, 'utf8')).trim()
  await page.fill('#mnemonicInput', mnemonic)
  await page.click('#restoreBtn')
  await page.waitForSelector('#didKeyText:not(:empty)', { timeout: 10000, state: 'attached' })

  // --- Find the vanilla account and select it ---
  await page.click('#createaccount-tab')
  await page.click('#account-list-subtab')

  let found = false
  for (let attempt = 0; attempt < 15 && !found; attempt++) {
    if (attempt > 0) await page.waitForTimeout(3000)
    await page.fill('#account-find-handle', lookupHandle)
    await page.click('#account-find-btn')
    try {
      await page.waitForFunction(
        () => {
          const status = document.getElementById('account-find-status')
          return status && status.textContent.trim() === ''
        },
        null,
        { timeout: 4000 },
      )
      found = true
    } catch {
      const statusText = (await page.locator('#account-find-status').textContent().catch(() => '')) || ''
      console.log(`Account not resolvable yet (attempt ${attempt + 1}): ${statusText.trim()}`)
    }
  }
  if (!found) throw new Error('Could not resolve the vanilla account by handle')
  console.log('vanilla account found and selected')

  // --- Migrate tab: should offer "take control" ---
  await page.click('#migrate-tab')
  await page.waitForSelector('#migrate-take-control-btn', { timeout: 15000 })
  console.log('Migrate tab confirms the held key is not yet registered - take-control button shown')

  const [oauthPopup] = await Promise.all([
    page.waitForEvent('popup'),
    page.click('#migrate-take-control-btn'),
  ])
  oauthPopup.on('console', (msg) => console.log(`[oauth.${msg.type()}] ${msg.text()}`))
  oauthPopup.on('pageerror', (err) => console.log(`[oauth pageerror] ${err}`))

  await oauthPopup.waitForURL(/\/oauth\/authorize/, { timeout: 20000 })
  await oauthPopup.waitForLoadState('networkidle').catch(() => {})
  console.log('reached sign-in page:', oauthPopup.url())

  await oauthPopup.locator('#identifier').fill(lookupHandle)
  await oauthPopup.locator('#password').fill(ACCOUNT_PASSWORD)
  await oauthPopup.locator('button[name="action"][value="sign-in"]').click()
  await oauthPopup.waitForLoadState('networkidle').catch(() => {})
  await oauthPopup.waitForTimeout(1000)
  console.log('AFTER_SIGNIN_URL:', oauthPopup.url())

  await oauthPopup.locator('button[name="action"][value="allow"]').click()
  console.log('signed in and authorized on the real OAuth consent page')

  // --- doPlcCosign's in-popup confirmation-code form ---
  await oauthPopup.locator('#plc-token-input').waitFor({ timeout: 20000 })
  console.log('popup is showing the email-confirmation-code form - requestPlcOperationSignature already ran')

  const token = await readPlcOperationToken(email)
  console.log(`read confirmation token via vlpds.admin.getDevMail: ${token}`)

  await oauthPopup.locator('#plc-token-input').fill(token)
  await oauthPopup.locator('#plc-token-submit').click()

  // --- Back on the main page: take-control should now report success ---
  await page.waitForSelector('#migrate-take-control-status .migrate-status-box.success', { timeout: 20000 })
  const finalStatus = (await page.locator('#migrate-take-control-status .migrate-status-box.success').textContent()).trim()
  console.log('take-control succeeded:', finalStatus)

  // Independently verify against plc.directory itself, not just this app's
  // own UI.
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
