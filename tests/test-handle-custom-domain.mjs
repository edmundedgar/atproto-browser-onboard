#!/usr/bin/env node
// Exercises the Handle tab's custom-domain path end to end: creates an
// account, publishes a real _atproto TXT record for a gwei.name test label
// (simulating the not-yet-built blockchain-watching bot by writing straight
// to /var/www/gwei/atproto-did/<label> - the same file it will write to),
// then drives the Handle tab's "Custom domain..." option with a blank
// subdomain (the root-domain-as-handle case) through to the domain.html popup's
// manual "I've set this up" check flow: idle button -> checking -> success
// tick -> auto-close, and confirms the main page gets notified (via
// postMessage from the popup) and unlocks "Change handle". A second phase
// then edits the field to an unpublished label and confirms the check's
// *failure* path too: message -> automatic slow poll -> Cancel reverting to
// the idle button.
//
// gwei.name is used here purely as a convenient *real* DNS zone this box
// can write to - not because it's special to the generic custom-domain
// code path, and not to be confused with the Handle tab's separate,
// dedicated ".gwei.name" option (GWEI_DOMAIN_VALUE), which goes through
// domain.html's on-chain GNS branch instead of typed-in DNS-TXT instructions.
// That dedicated option is checked below too, but only up to the
// wallet-connect prompt - actually submitting a setText transaction needs
// a real wallet with a real registered .gwei name, which nothing in this
// sandbox has (same limitation as the .eth.xyz/ENS path, which has never
// had automated coverage past its own wallet-connect prompt either).
//
// The record is published *before* the popup's check button is ever
// clicked: an earlier design (auto-poll from page load) was scrapped
// entirely because of this - Cloudflare's DoH resolver (which
// resolveHandleToDid/resolveAtprotoTxtRecord query) caches a *negative*
// answer for a not-yet-existing name for the zone's negative-cache TTL
// (~5 minutes per gwei.name's SOA), even though the authoritative
// nameserver itself only takes ~6s to update - so any check that fires
// before the record exists can end up "failing" for minutes after the
// record is authoritatively live. The whole point of the manual-check
// redesign is that the first-ever query for a name only happens once the
// user believes it's ready; this test honors that by publishing (and
// confirming on the authoritative server) before ever clicking "check".
//
// Deliberately stops short of actually submitting the handle change (that
// goes through a real OAuth login popup against the PDS - no test in this
// suite drives that flow yet, custom domain or otherwise), and deliberately
// skips the .well-known file method (would need real webserver access on a
// domain we don't have that for, whereas gwei.name's file-drop pipeline is
// right here and already verified to work).
//
// Usage: node test-handle-custom-domain.mjs [test-label]

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

const testLabel = process.argv[2] || `pwtest${Date.now().toString(36)}`
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

// Polls the authoritative nameserver directly (bypassing any recursive
// resolver's cache) for a TXT record containing `expectedContains`.
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

    // Restore the persistent seed, same convention as the other tests here.
    const mnemonic = (await fs.readFile(SEED_PATH, 'utf8')).trim()
    await page.fill('#mnemonicInput', mnemonic)
    await page.click('#restoreBtn')
    await page.waitForSelector('#didKeyText:not(:empty)', { timeout: 10000, state: 'attached' })

    // --- Create an account (Handle tab operates on selectedAccount, which
    // createAccount sets automatically on success) ---
    await page.click('#createaccount-tab')
    await page.fill('#pds-endpoint', '')
    await page.fill('#pds-endpoint', PDS_ENDPOINT)
    await page.locator('#pds-endpoint').blur()
    await page.waitForSelector('#account-handle-domain option:not([value=""])', { timeout: 10000, state: 'attached' })
    const handleDomain = await page.locator('#account-handle-domain option:not([value=""])').first().getAttribute('value')
    await page.selectOption('#account-handle-domain', handleDomain)

    // Reference PDS caps subdomain labels at 18 chars (ensureHandleServiceConstraints).
    const accountSubdomain = testLabel
    await page.fill('#account-handle-subdomain', accountSubdomain)
    await page.fill('#account-email', `${accountSubdomain}@test.invalid`)
    await page.fill('#account-password', ACCOUNT_PASSWORD)
    await page.fill('#account-invite-code', inviteCode)
    await page.click('#submit-createaccount-btn')
    await waitForAccountCreated(page)

    // knownAccounts/selectedAccount live in module scope, invisible to
    // page.evaluate() - but createAccount's success path also persists them
    // to localStorage (see upsertKnownAccount/KNOWN_ACCOUNTS_STORAGE_KEY),
    // which is a plain Web API and reads fine from here. Fresh incognito-ish
    // context per run, so this is the only entry.
    const did = await page.evaluate(() => {
      const list = JSON.parse(localStorage.getItem('atproto-onboard:known-accounts') || '[]')
      return list[0]?.did || null
    })
    if (!did) throw new Error('Could not read the created account DID from localStorage')
    console.log(`account created: did=${did}`)

    // --- Publish the gwei.name record *before* anything ever queries for
    // it (see the negative-caching note up top) ---
    await fs.writeFile(gweiDidFile, `${did}\n`)
    console.log(`wrote ${gweiDidFile}, waiting for it to reach the authoritative nameserver...`)
    const published = await waitForAuthoritativeTxt(`_atproto.${customDomainHandle}`, `did=${did}`)
    if (!published) throw new Error(`_atproto.${customDomainHandle} TXT record never reached ${GWEI_AUTHORITATIVE_NS}`)
    console.log('record confirmed on the authoritative nameserver')

    // --- Handle tab: switch to it, select Custom domain, leave subdomain
    // blank (root-domain-as-handle case) ---
    //
    // enterHandleTab's own resolveSelectedAccount() call resolves the
    // account's *own* handle (via the same Cloudflare DoH lookup) before it
    // will render anything - this can race the just-created account's own
    // _atproto.<handle> TXT record propagating (published by a separate,
    // already-live pipeline on this PDS, confirmed by the id.goat.navy zone
    // file already containing entries for every account this suite has ever
    // created), so retry entry a few times rather than treating one failure
    // as fatal. enterHandleTab only retries the lookup if handleState.did
    // still differs from selectedAccount.did when it's re-entered, which
    // holds here since a failed lookup never advances handleState.did.
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

    // --- Dedicated ".gwei.name" option: UI/URL wiring only, up to the
    // wallet-connect prompt (see the top-of-file note - no real wallet
    // available here, same limitation as .eth.xyz) ---
    await page.waitForSelector('#handle-new-domain option[value=".gwei.name"]', { timeout: 5000, state: 'attached' })
    await page.selectOption('#handle-new-domain', '.gwei.name')

    const gweiSetupBtnDisabledEmpty = await page.locator('#handle-setup-btn').isDisabled()
    if (!gweiSetupBtnDisabledEmpty) throw new Error('#handle-setup-btn should be disabled before the subdomain is filled in for .gwei.name')

    const gweiSubdomain = `${testLabel}gwei`
    await page.fill('#handle-new-subdomain', gweiSubdomain)
    await page.waitForFunction(() => !document.getElementById('handle-setup-btn')?.disabled, null, { timeout: 3000 })

    const gweiSetupBtnText = (await page.locator('#handle-setup-btn').textContent() || '').trim()
    if (gweiSetupBtnText !== 'Set up .gwei') throw new Error(`Expected "Set up .gwei" button, got "${gweiSetupBtnText}"`)

    const [gweiPopup] = await Promise.all([
      page.waitForEvent('popup'),
      page.click('#handle-setup-btn'),
    ])
    gweiPopup.on('console', (msg) => console.log(`[gweiPopup.${msg.type()}] ${msg.text()}`))
    gweiPopup.on('pageerror', (err) => console.log(`[gweiPopup pageerror] ${err}`))
    await gweiPopup.waitForLoadState()

    const gweiFields = await gweiPopup.locator('.module').first().locator('.value').allTextContents()
    const [gweiRenderedName, gweiRenderedDid] = gweiFields.map((s) => s.trim())
    if (gweiRenderedName !== `${gweiSubdomain}.gwei`) throw new Error(`domain.html popup shows gwei name "${gweiRenderedName}", expected "${gweiSubdomain}.gwei"`)
    if (gweiRenderedDid !== did) throw new Error(`domain.html popup shows did "${gweiRenderedDid}", expected "${did}"`)

    const gweiConnectWcText = (await gweiPopup.locator('#connect-wc-btn').textContent() || '').trim()
    if (gweiConnectWcText !== 'Connect via WalletConnect') throw new Error(`Expected the wallet-connect prompt, got "${gweiConnectWcText}"`)
    console.log(`.gwei.name option correctly opened domain.html?gwei=${gweiSubdomain}, showing the wallet-connect prompt with name=${gweiRenderedName} did=${gweiRenderedDid}`)

    await gweiPopup.close()

    // Reset before moving on to the generic custom-domain flow below - it
    // expects a blank subdomain field for its own root-domain test case.
    await page.fill('#handle-new-subdomain', '')
    await page.selectOption('#handle-new-domain', '')

    await page.selectOption('#handle-new-domain', '__custom__')

    // Deterministic, no DNS involved: handleTabDomainChange disables the
    // Change button the instant "Custom domain..." is selected, regardless
    // of whether the domain field has a value yet.
    const changeBtnDisabledOnSelect = await page.locator('#handle-change-btn').isDisabled()
    if (!changeBtnDisabledOnSelect) throw new Error('#handle-change-btn should be disabled as soon as "Custom domain..." is selected')

    const customGroupHidden = await page.locator('#handle-custom-domain-group').evaluate((el) => el.classList.contains('hidden'))
    if (customGroupHidden) throw new Error('#handle-custom-domain-group should be visible once "Custom domain..." is selected')

    const selectHiddenWhileCustom = await page.locator('#handle-new-domain').evaluate((el) => el.classList.contains('hidden'))
    if (!selectHiddenWhileCustom) throw new Error('#handle-new-domain select should hide while the custom-domain input takes its place')

    // Revert (×) round-trip: swaps the select back in and clears the field.
    await page.fill('#handle-new-custom-domain', 'throwaway.example.com')
    await page.click('#handle-custom-domain-revert')
    const selectVisibleAfterRevert = await page.locator('#handle-new-domain').evaluate((el) => !el.classList.contains('hidden'))
    const customGroupHiddenAfterRevert = await page.locator('#handle-custom-domain-group').evaluate((el) => el.classList.contains('hidden'))
    const selectValueAfterRevert = await page.locator('#handle-new-domain').inputValue()
    if (!selectVisibleAfterRevert) throw new Error('#handle-new-domain select should reappear after clicking revert')
    if (!customGroupHiddenAfterRevert) throw new Error('#handle-custom-domain-group should hide after clicking revert')
    if (selectValueAfterRevert !== '') throw new Error(`select should reset to the placeholder after revert, got "${selectValueAfterRevert}"`)
    console.log('revert (×) button correctly swaps the select back in and clears the custom domain field')

    // Re-select custom domain to continue the real flow.
    await page.selectOption('#handle-new-domain', '__custom__')

    await page.waitForSelector('#handle-setup-btn', { timeout: 5000 })
    const setupBtnText = (await page.locator('#handle-setup-btn').textContent() || '').trim()
    if (setupBtnText !== 'Set up custom domain') throw new Error(`Expected "Set up custom domain" button, got "${setupBtnText}"`)

    const setupBtnDisabledWhenEmpty = await page.locator('#handle-setup-btn').isDisabled()
    if (!setupBtnDisabledWhenEmpty) throw new Error('#handle-setup-btn should be disabled while the custom domain field is empty')
    console.log('setup button correctly disabled before the custom domain field is filled in')

    await page.fill('#handle-new-custom-domain', customDomainHandle)
    await page.waitForFunction(() => !document.getElementById('handle-setup-btn')?.disabled, null, { timeout: 3000 })
    console.log('setup button correctly enabled once the custom domain field has a value')

    const [popup] = await Promise.all([
      page.waitForEvent('popup'),
      page.click('#handle-setup-btn'),
    ])
    popup.on('console', (msg) => console.log(`[popup.${msg.type()}] ${msg.text()}`))
    popup.on('pageerror', (err) => console.log(`[popup pageerror] ${err}`))
    await popup.waitForLoadState()

    // Dot separator should hide - blank subdomain + custom domain means the
    // whole handle is just the custom domain, not ".{customDomain}".
    await page.waitForFunction(() => document.getElementById('handle-dot-separator')?.classList.contains('hidden'), null, { timeout: 5000 })
    console.log('dot separator correctly hidden for blank-subdomain custom domain')

    await popup.waitForSelector('#custom-domain-status', { timeout: 10000, state: 'attached' })
    const fields = await popup.locator('.module').first().locator('.value').allTextContents()
    const [renderedHandle, renderedDid] = fields.map((s) => s.trim())
    if (renderedHandle !== customDomainHandle) throw new Error(`domain.html popup shows handle "${renderedHandle}", expected "${customDomainHandle}"`)
    if (renderedDid !== did) throw new Error(`domain.html popup shows did "${renderedDid}", expected "${did}"`)
    console.log(`popup rendered handle=${renderedHandle} did=${renderedDid}`)

    const recordModuleText = await popup.locator('.module').nth(1).textContent()
    const expectedRecordName = `_atproto.${customDomainHandle}`
    const expectedRecordValue = `did=${did}`
    if (!recordModuleText.includes(expectedRecordName)) throw new Error(`popup instructions missing expected record name "${expectedRecordName}"`)
    if (!recordModuleText.includes(expectedRecordValue)) throw new Error(`popup instructions missing expected record value "${expectedRecordValue}"`)
    console.log('popup instructions show the correct DNS TXT record name/value')

    // --- Manual check, success path: idle button -> checking -> tick ---
    await popup.waitForSelector('#custom-domain-status button', { timeout: 5000 })
    const idleBtnText = (await popup.locator('#custom-domain-status button').textContent() || '').trim()
    if (idleBtnText !== "I've set this up") throw new Error(`Expected "I've set this up" button, got "${idleBtnText}"`)
    console.log('popup shows the idle "I\'ve set this up" button - no auto-poll fired yet')

    await popup.click('#custom-domain-status button')
    await popup.waitForSelector('#custom-domain-status .status.loading', { timeout: 3000 })
    console.log('popup shows "Checking..." immediately after the click')

    await popup.waitForSelector('#custom-domain-status .status.success', { timeout: 15000 })
    const successText = (await popup.locator('#custom-domain-status .status.success').textContent()).trim()
    if (!successText.includes('is live')) throw new Error(`unexpected success text: "${successText}"`)
    if (!successText.includes('✓')) throw new Error(`expected a checkmark in the success message, got "${successText}"`)
    console.log('popup confirmed success:', successText)

    await popup.waitForFunction(() => (document.getElementById('header-checking')?.textContent || '') === '', null, { timeout: 5000 })
    console.log('popup header-checking indicator correctly cleared on success')

    // Popup should auto-close a couple seconds after confirming, and the
    // main page should learn of it via postMessage (not its own polling -
    // there isn't any any more) and unlock Change handle.
    await popup.waitForEvent('close', { timeout: 8000 })
    console.log('popup closed itself after confirming')

    await page.waitForFunction(() => document.getElementById('handle-change-btn') && !document.getElementById('handle-change-btn').disabled, null, { timeout: 5000 })
    const setupGroupText = (await page.locator('#handle-setup-group').textContent() || '').trim()
    if (!/ready/i.test(setupGroupText)) throw new Error(`expected #handle-setup-group to show a "ready" note, got "${setupGroupText}"`)
    console.log('main page received the postMessage confirmation, Change handle button enabled')

    // --- Phase 2: edit the field to an unpublished label and confirm the
    // failure path (message + auto slow-poll + Cancel reverting to idle) ---
    const unpublishedHandle = `${testLabel}-nope.gwei.name`
    await page.fill('#handle-new-custom-domain', unpublishedHandle)

    // Editing after confirmation should invalidate the stale "ready" state.
    await page.waitForFunction(() => {
      const btn = document.getElementById('handle-change-btn')
      return btn && btn.disabled
    }, null, { timeout: 5000 })
    await page.waitForSelector('#handle-setup-btn', { timeout: 5000 })
    console.log('editing the field after confirmation correctly reverted to the unconfirmed state')

    const [popup2] = await Promise.all([
      page.waitForEvent('popup'),
      page.click('#handle-setup-btn'),
    ])
    popup2.on('console', (msg) => console.log(`[popup2.${msg.type()}] ${msg.text()}`))
    popup2.on('pageerror', (err) => console.log(`[popup2 pageerror] ${err}`))
    await popup2.waitForLoadState()
    await popup2.waitForSelector('#custom-domain-status button', { timeout: 10000 })

    await popup2.click('#custom-domain-status button')
    await popup2.waitForSelector('#custom-domain-status .status.loading', { timeout: 3000 })
    // The check itself has a ~3s built-in delay before it even queries, plus
    // the query for a genuinely nonexistent name - give it a wide margin.
    await popup2.waitForSelector('#custom-domain-status .status.error', { timeout: 15000 })
    const failureText = (await popup2.locator('#custom-domain-status .status.error').textContent()).trim()
    if (!/didn.t find it yet/i.test(failureText)) throw new Error(`unexpected failure text: "${failureText}"`)
    console.log('popup correctly reported failure:', failureText)

    const cancelBtnText = (await popup2.locator('#custom-domain-status button').textContent() || '').trim()
    if (cancelBtnText !== 'Cancel') throw new Error(`Expected a "Cancel" button after failure, got "${cancelBtnText}"`)

    await popup2.click('#custom-domain-status button')
    await popup2.waitForFunction(() => {
      const btn = document.querySelector('#custom-domain-status button')
      return btn && btn.textContent.trim() === "I've set this up"
    }, null, { timeout: 5000 })
    await popup2.waitForFunction(() => (document.getElementById('header-checking')?.textContent || '') === '', null, { timeout: 5000 })
    console.log('Cancel correctly reverted the popup to the idle state and stopped the slow poll')

    await popup2.close()
    console.log('--- PASS ---')
  } finally {
    // Take the record back down regardless of outcome. The sync pipeline
    // treats an emptied-but-present file as the teardown signal - a file
    // disappearing outright is deliberately *not* treated as one (so a
    // mid-write truncate-then-rewrite can't misfire as a removal), which
    // also means deleting the file immediately after emptying it races the
    // pipeline: confirmed by hand that doing so can leave the old value
    // live in DNS indefinitely. So: empty it, wait for the authoritative
    // server to actually drop the record, only then delete the now-inert
    // file (these are one-off labels that will never be reused, so there's
    // no reason to leave an empty tombstone behind).
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
