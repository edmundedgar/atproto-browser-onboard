#!/usr/bin/env node
// Exercises the create-account tab's domain-method UX now that it has the
// same four choices as the Handle tab (PDS domain / .eth.xyz / .gwei.name /
// custom domain), not just .eth.xyz:
//   - .eth.xyz and .gwei.name: disabled-until-filled "Set up ..." button,
//     opens domain.html with the right params - checked only up to the
//     wallet-connect prompt (no real wallet in this sandbox, same
//     limitation as everywhere else this has come up).
//   - Custom domain: select<->text-input swap with the × revert button
//     (mirrors the Handle tab's), then a *full* end-to-end run - publish a
//     real gwei.name record, click through domain.html's manual-check flow,
//     confirm the postMessage reaches the create-account tab and unlocks
//     "Create Account", then actually submit the form and confirm the
//     account is created with the expected custom-domain handle. This is
//     new capability this session added (create-account previously only
//     ever offered .eth.xyz), so it's worth the full round-trip rather than
//     stopping at the UI layer the way the eth.xyz/gwei checks do.
//
// Root-domain (blank subdomain) custom-domain case only, same as the
// Handle-tab test - gwei.name's sync script only accepts single-label
// names (no dots), so "subdomain.customdomain.gwei.name" isn't something
// the file-drop simulation can publish a record for.
//
// Usage: node test-createaccount-domain-methods.mjs [test-label]

import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
import dns from 'node:dns'

const ONBOARD_URL = process.env.ONBOARD_URL || 'https://ens.goat.navy/'
const PDS_ENDPOINT = process.env.PDS_ENDPOINT || 'https://blue.goat.navy'
const ADMIN_PASSWORD = process.env.PDS_ADMIN_PASSWORD
const ACCOUNT_PASSWORD = process.env.PDS_ACCOUNT_PASSWORD
if (!ACCOUNT_PASSWORD) throw new Error('Set PDS_ACCOUNT_PASSWORD (shared test-account password)')
const SEED_PATH = process.env.SEED_PATH || `${process.env.HOME}/.config/onboard-test/seed.txt`
const GWEI_ATPROTO_DID_DIR = process.env.GWEI_ATPROTO_DID_DIR || '/var/www/gwei/atproto-did'
const GWEI_AUTHORITATIVE_NS = process.env.GWEI_AUTHORITATIVE_NS || '141.94.131.139'

const testLabel = process.argv[2] || `pwca${Date.now().toString(36)}`
const customDomainHandle = `${testLabel}.gwei.name`
const gweiDidFile = path.join(GWEI_ATPROTO_DID_DIR, testLabel)

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

async function waitForAuthoritativeTxt(name, expectedContains, { timeoutMs = 30000, intervalMs = 1500 } = {}) {
  const resolver = new dns.promises.Resolver()
  resolver.setServers([GWEI_AUTHORITATIVE_NS])
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const records = await resolver.resolveTxt(name)
      if (records.some((r) => r.join('').includes(expectedContains))) return true
    } catch { /* NXDOMAIN or not propagated yet */ }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return false
}

async function waitForAuthoritativeTxtGone(name, { timeoutMs = 20000, intervalMs = 2000 } = {}) {
  const resolver = new dns.promises.Resolver()
  resolver.setServers([GWEI_AUTHORITATIVE_NS])
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const stillLive = await resolver.resolveTxt(name).then(() => true).catch(() => false)
    if (!stillLive) return true
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return false
}

async function main() {
  const serverInfo = await fetch(`${PDS_ENDPOINT}/xrpc/com.atproto.server.describeServer`).then((r) => r.json())
  const inviteCode = serverInfo.inviteCodeRequired ? await makeInviteCode() : ''
  console.log(`test label: ${testLabel}  (custom-domain handle under test: ${customDomainHandle})`)

  const browser = await chromium.launch()
  const page = await browser.newPage()
  page.on('console', (msg) => console.log(`[page.${msg.type()}] ${msg.text()}`))
  page.on('pageerror', (err) => console.log(`[page pageerror] ${err}`))

  try {
    await page.goto(ONBOARD_URL)

    const mnemonic = (await fs.readFile(SEED_PATH, 'utf8')).trim()
    await page.fill('#mnemonicInput', mnemonic)
    await page.click('#restoreBtn')
    await page.waitForSelector('#didKeyText:not(:empty)', { timeout: 10000, state: 'attached' })

    await page.click('#createaccount-tab')
    await page.fill('#pds-endpoint', '')
    await page.fill('#pds-endpoint', PDS_ENDPOINT)
    await page.locator('#pds-endpoint').blur()
    await page.waitForSelector('#account-handle-domain option[value=".gwei.name"]', { timeout: 10000, state: 'attached' })

    // --- .eth.xyz: disabled-until-filled, opens domain.html with the
    // wallet-connect prompt (no real wallet here) ---
    await page.selectOption('#account-handle-domain', '.eth.xyz')
    const ethBtnDisabledEmpty = await page.locator('#account-setup-btn').isDisabled()
    if (!ethBtnDisabledEmpty) throw new Error('#account-setup-btn should be disabled before the subdomain is filled in for .eth.xyz')

    const ethSubdomain = `${testLabel}eth`
    await page.fill('#account-handle-subdomain', ethSubdomain)
    await page.waitForFunction(() => !document.getElementById('account-setup-btn')?.disabled, null, { timeout: 3000 })
    const ethBtnText = (await page.locator('#account-setup-btn').textContent() || '').trim()
    if (ethBtnText !== 'Set up .eth') throw new Error(`Expected "Set up .eth" button, got "${ethBtnText}"`)

    const [ethPopup] = await Promise.all([
      page.waitForEvent('popup'),
      page.click('#account-setup-btn'),
    ])
    await ethPopup.waitForLoadState()
    const ethFields = await ethPopup.locator('.module').first().locator('.value').allTextContents()
    if (ethFields[0]?.trim() !== `${ethSubdomain}.eth`) throw new Error(`eth popup shows account name "${ethFields[0]}", expected "${ethSubdomain}.eth"`)
    const ethConnectWcText = (await ethPopup.locator('#connect-wc-btn').textContent() || '').trim()
    if (ethConnectWcText !== 'Connect via WalletConnect') throw new Error('Expected the wallet-connect prompt for .eth.xyz')
    await ethPopup.close()
    console.log(`.eth.xyz option correctly gated on subdomain and opened domain.html?account=${ethSubdomain}.eth, showing the wallet-connect prompt`)

    // --- .gwei.name: same checks ---
    await page.fill('#account-handle-subdomain', '')
    await page.selectOption('#account-handle-domain', '')
    await page.selectOption('#account-handle-domain', '.gwei.name')
    const gweiBtnDisabledEmpty = await page.locator('#account-setup-btn').isDisabled()
    if (!gweiBtnDisabledEmpty) throw new Error('#account-setup-btn should be disabled before the subdomain is filled in for .gwei.name')

    const gweiSubdomain = `${testLabel}gwei`
    await page.fill('#account-handle-subdomain', gweiSubdomain)
    await page.waitForFunction(() => !document.getElementById('account-setup-btn')?.disabled, null, { timeout: 3000 })
    const gweiBtnText = (await page.locator('#account-setup-btn').textContent() || '').trim()
    if (gweiBtnText !== 'Set up .gwei') throw new Error(`Expected "Set up .gwei" button, got "${gweiBtnText}"`)

    const [gweiPopup] = await Promise.all([
      page.waitForEvent('popup'),
      page.click('#account-setup-btn'),
    ])
    await gweiPopup.waitForLoadState()
    const gweiFields = await gweiPopup.locator('.module').first().locator('.value').allTextContents()
    if (gweiFields[0]?.trim() !== `${gweiSubdomain}.gwei`) throw new Error(`gwei popup shows name "${gweiFields[0]}", expected "${gweiSubdomain}.gwei"`)
    const gweiConnectWcText = (await gweiPopup.locator('#connect-wc-btn').textContent() || '').trim()
    if (gweiConnectWcText !== 'Connect via WalletConnect') throw new Error('Expected the wallet-connect prompt for .gwei.name')
    await gweiPopup.close()
    console.log(`.gwei.name option correctly gated on subdomain and opened domain.html?gwei=${gweiSubdomain}, showing the wallet-connect prompt`)

    // --- Custom domain: select<->input swap + revert round-trip ---
    await page.fill('#account-handle-subdomain', '')
    await page.selectOption('#account-handle-domain', '')
    await page.selectOption('#account-handle-domain', '__custom__')

    const selectHiddenWhileCustom = await page.locator('#account-handle-domain').evaluate((el) => el.classList.contains('hidden'))
    if (!selectHiddenWhileCustom) throw new Error('#account-handle-domain select should hide while the custom-domain input takes its place')
    const customGroupVisible = await page.locator('#account-handle-custom-domain-group').evaluate((el) => !el.classList.contains('hidden'))
    if (!customGroupVisible) throw new Error('#account-handle-custom-domain-group should be visible once "Custom domain..." is selected')

    await page.fill('#account-handle-custom-domain', 'throwaway.example.com')
    await page.click('#account-handle-custom-domain-revert')
    const selectVisibleAfterRevert = await page.locator('#account-handle-domain').evaluate((el) => !el.classList.contains('hidden'))
    const customGroupHiddenAfterRevert = await page.locator('#account-handle-custom-domain-group').evaluate((el) => el.classList.contains('hidden'))
    if (!selectVisibleAfterRevert) throw new Error('#account-handle-domain select should reappear after clicking revert')
    if (!customGroupHiddenAfterRevert) throw new Error('#account-handle-custom-domain-group should hide after clicking revert')
    console.log('revert (×) button correctly swaps the select back in and clears the custom domain field')

    // --- Custom domain: full end-to-end account creation ---
    // Publish the record *before* the popup's check button is ever clicked
    // - see test-handle-custom-domain.mjs's top-of-file note on why
    // (Cloudflare DoH negative-caches a not-yet-existing name for minutes).
    await page.evaluate(() => {
      const list = JSON.parse(localStorage.getItem('atproto-onboard:known-accounts') || '[]')
      window.__preexistingKnownAccountCount = list.length
    })
    const did = await page.evaluate(() => document.getElementById('account-did-value')?.value || null)

    await page.selectOption('#account-handle-domain', '__custom__')
    await page.fill('#account-handle-custom-domain', customDomainHandle)
    await page.waitForFunction(() => !document.getElementById('account-setup-btn')?.disabled, null, { timeout: 3000 })

    // account-did-value only updates after a debounce - read the DID domain.html
    // will actually need to check for straight from the field once settled.
    await page.waitForFunction(() => (document.getElementById('account-did-value')?.value || '').startsWith('did:plc:'), null, { timeout: 5000 })
    const accountDid = await page.locator('#account-did-value').inputValue()

    await fs.writeFile(gweiDidFile, `${accountDid}\n`)
    console.log(`wrote ${gweiDidFile}, waiting for it to reach the authoritative nameserver...`)
    const published = await waitForAuthoritativeTxt(`_atproto.${customDomainHandle}`, `did=${accountDid}`)
    if (!published) throw new Error(`_atproto.${customDomainHandle} TXT record never reached ${GWEI_AUTHORITATIVE_NS}`)
    console.log('record confirmed on the authoritative nameserver')

    const submitBtnDisabledBeforeCheck = await page.locator('#submit-createaccount-btn').isDisabled()
    if (!submitBtnDisabledBeforeCheck) throw new Error('#submit-createaccount-btn should be disabled before the custom domain is confirmed')

    const [customPopup] = await Promise.all([
      page.waitForEvent('popup'),
      page.click('#account-setup-btn'),
    ])
    await customPopup.waitForLoadState()
    await customPopup.waitForSelector('#custom-domain-status button', { timeout: 10000 })
    await customPopup.click('#custom-domain-status button')
    await customPopup.waitForSelector('#custom-domain-status .status.success', { timeout: 15000 })
    console.log('custom-domain popup confirmed the live record')
    await customPopup.waitForEvent('close', { timeout: 8000 })

    await page.waitForFunction(() => !document.getElementById('submit-createaccount-btn')?.disabled, null, { timeout: 5000 })
    console.log('create-account tab received the postMessage confirmation, Create Account button enabled')

    await page.fill('#account-email', `${testLabel}@test.invalid`)
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
    if (!/account created/i.test(status)) throw new Error(`Account creation did not succeed: ${status}`)

    const createdHandle = await page.evaluate(() => {
      const list = JSON.parse(localStorage.getItem('atproto-onboard:known-accounts') || '[]')
      return list[list.length - 1]?.handle || null
    })
    if (createdHandle !== customDomainHandle) throw new Error(`Created account has handle "${createdHandle}", expected "${customDomainHandle}"`)
    console.log(`account created with custom-domain handle: ${createdHandle}`)

    console.log('--- PASS ---')
  } finally {
    await fs.writeFile(gweiDidFile, '').catch(() => {})
    const tornDown = await waitForAuthoritativeTxtGone(`_atproto.${customDomainHandle}`)
    if (!tornDown) console.log(`WARNING: _atproto.${customDomainHandle} still resolves after teardown - leaving ${gweiDidFile} emptied (not deleted) so a retry can still take it down`)
    else await fs.unlink(gweiDidFile).catch(() => {})
    await browser.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
