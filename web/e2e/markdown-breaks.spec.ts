import { join } from 'node:path'
import { createSession, expect, expectTerminal, test, typeInTerminal } from './fixtures'

// A line break the person typed shows as a line break (GitHub-comment style); agent prose stays CommonMark.

const SHOTS = process.env.MD_SHOTS

const USER = 'line1\nline2\r\n\npara2\n- a\n- b\n- [ ] todo\n- [x] done\n~~gone~~ https://example.com/x\n> q1\n> q2\n```\ncode\nmore\n```\n日本語1\n日本語2\n'

test('user message: single newlines are <br>; code, paragraphs and lists intact; agent stays strict', async ({ page, minbox }) => {
  if (SHOTS) await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'alpha')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'say agent1\\nagent2')
  await expectTerminal(page, 'sent in thr_')
  const sess = (await (await page.request.get(minbox.url + '/api/sessions')).json())[0]
  const r = await page.request.post(`${minbox.url}/api/sessions/${sess.id}/threads`, { data: { subject: 'Breaks', body: USER } })
  expect(r.ok()).toBe(true)
  const thr = (await r.json()).id as string
  await page.goto(`${minbox.url}/#s=${sess.id}&t=${thr}`)
  const md = page.getByTestId('message').first().locator('.md').first()
  await expect(md).toContainText('para2')
  const html = await md.innerHTML()
  expect(html).toMatch(/line1<br>\s*line2<\/p>/)
  expect(html).not.toMatch(/<br>\s*<br>/)
  expect(html).toMatch(/<p>para2<\/p>/)
  expect(html).toContain('<li>a</li>')
  expect(html).toContain('<del>gone</del>')
  expect(html).toMatch(/<a href="https:\/\/example.com\/x"/)
  expect(html).toMatch(/q1<br>\s*q2/)
  expect(html).toMatch(/<code[^>]*>code\nmore\n<\/code>/)
  expect(html).toMatch(/日本語1<br>\s*日本語2\s*<\/p>/)
  await expect(md.locator('input[type=checkbox]')).toHaveCount(2)
  await expect(md.locator('input[type=checkbox]').first()).toBeDisabled()
  await expect(md.locator('script, iframe')).toHaveCount(0)
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'md-breaks.png') })
  // The agent's single newline is a soft break: no <br>.
  await page.goto(`${minbox.url}/#s=${sess.id}`)
  await page.getByTestId('thread-row').filter({ hasText: 'agent1' }).first().click()
  const a = page.getByTestId('message').first().locator('.md').first()
  await expect(a).toContainText('agent1')
  expect(await a.innerHTML()).not.toContain('<br')
})
