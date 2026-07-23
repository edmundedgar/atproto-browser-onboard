#!/usr/bin/env node
// One-off: generate a single mnemonic via the page's own key-generation code
// and save it outside the repo, so all test runs can reuse the same seed
// instead of minting a fresh key every time.

import { chromium } from 'playwright'
import fs from 'node:fs/promises'

const ONBOARD_URL = process.env.ONBOARD_URL || 'https://ens.goat.navy/'
const OUT_PATH = process.env.SEED_PATH || `${process.env.HOME}/.config/onboard-test/seed.txt`

const browser = await chromium.launch()
const page = await browser.newPage()
await page.goto(ONBOARD_URL)
await page.click('#generateBtn')
await page.waitForSelector('#mnemonicText:not(:empty)', { timeout: 10000 })
const mnemonic = (await page.textContent('#mnemonicText')).trim()
await browser.close()

await fs.writeFile(OUT_PATH, mnemonic + '\n', { mode: 0o600 })
console.log(`saved seed to ${OUT_PATH}`)
