import { chromium } from 'playwright'
import fs from 'node:fs/promises'

const SEED_PATH = process.env.SEED_PATH || `${process.env.HOME}/.config/onboard-test/seed.txt`

const browser = await chromium.launch()
const page = await browser.newPage()
page.on('console', (msg) => console.log(`[console.${msg.type()}] ${msg.text()}`))
await page.goto('https://ens.goat.navy/')

const mnemonic = (await fs.readFile(SEED_PATH, 'utf8')).trim()
await page.fill('#mnemonicInput', mnemonic)
await page.click('#restoreBtn')
await page.waitForSelector('#didKeyText:not(:empty)', { timeout: 10000, state: 'attached' })

await page.click('#createaccount-tab')

// layout check
const box = await page.locator('.social-import-group').boundingBox()
const selectBox = await page.locator('#social-import-platform').boundingBox()
const inputBox = await page.locator('#social-import-username').boundingBox()
console.log('group width:', box.width, 'select width:', selectBox.width, 'input width:', inputBox.width)
console.log('side by side (select.x + select.width <= input.x)?', selectBox.x + selectBox.width <= inputBox.x)

// valid farcaster username
await page.fill('#social-import-username', 'dwr')
await page.waitForFunction(() => document.getElementById('social-import-check-status').textContent.includes('Found'), null, { timeout: 15000 })
console.log('farcaster check:', await page.locator('#social-import-check-status').textContent())

// invalid username
await page.fill('#social-import-username', 'this-username-should-not-exist-zzz99')
await page.waitForFunction(() => document.getElementById('social-import-check-status').textContent.includes('Not found'), null, { timeout: 15000 })
console.log('bad username check:', await page.locator('#social-import-check-status').textContent())

// switch to X, valid
await page.selectOption('#social-import-platform', 'x')
await page.fill('#social-import-username', 'jack')
await page.waitForFunction(() => document.getElementById('social-import-check-status').textContent.includes('Found'), null, { timeout: 15000 })
console.log('x check:', await page.locator('#social-import-check-status').textContent())

// clear -> reverts to help text
await page.fill('#social-import-username', '')
await page.waitForTimeout(900)
console.log('cleared:', await page.locator('#social-import-check-status').textContent())

await browser.close()
