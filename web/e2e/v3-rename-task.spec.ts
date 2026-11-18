// Renaming a task by hand: in the task view's header (double-click the title, the pencil, E / F2; ↵ saves,
// Esc cancels), from the Board row's ⋯ menu (or right-click, or E on the focused row), and on a phone
// (the task view's header). The timeline says "Renamed: old → new", and the task is the person's to
// name from then on.
import { expect, test } from './fixtures'
import { api, board, startAgent } from './v3'

async function newTask(minbox: any, projectId: string, title: string) {
  return api(minbox, 'POST', '/api/v3/tasks', { project_id: projectId, title })
}

test('task view: double-click the title to rename, Esc cancels, E starts it again; the timeline records it', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'alpha')
  const t = await newTask(minbox, a.project_id, 'Look into login')
  await page.goto(minbox.url + `/#v=task&k=${t.id}`)
  await expect(page.getByTestId('task-title')).toHaveText('Look into login')

  // Esc leaves the title as it was (and stays on the task).
  await page.getByTestId('task-title').dblclick()
  const input = page.getByTestId('task-title-input')
  await expect(input).toBeFocused()
  await input.fill('Never mind')
  await input.press('Escape')
  await expect(page.getByTestId('task-title')).toHaveText('Look into login')
  await expect(page.getByTestId('agent-task-detail')).toBeVisible()

  // ↵ saves.
  await page.getByTestId('task-title').dblclick()
  await input.fill('Fix login redirect loop')
  await input.press('Enter')
  await expect(page.getByTestId('task-title')).toHaveText('Fix login redirect loop')
  await expect.poll(async () => (await api(minbox, 'GET', `/api/v3/tasks/${t.id}`)).task.title).toBe('Fix login redirect loop')
  await expect(page.getByTestId('event').filter({ hasText: 'Renamed: Look into login → Fix login redirect loop (you)' })).toBeVisible()
  const d = await api(minbox, 'GET', `/api/v3/tasks/${t.id}`)
  expect(d.task.title_by).toBe('person')

  // E starts editing from the keyboard; the pencil does the same.
  await page.locator('body').click({ position: { x: 5, y: 300 } })
  await page.keyboard.press('e')
  await expect(input).toBeFocused()
  await input.fill('Fix the login loop on Safari')
  await input.press('Enter')
  await expect(page.getByTestId('task-title')).toHaveText('Fix the login loop on Safari')
  await page.getByTestId('task-rename').click()
  await expect(input).toHaveValue('Fix the login loop on Safari')
  await input.press('Escape')
})

test('Board: ⋯ › Rename and E on the focused row rename a task; other views follow', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'alpha')
  const t = await newTask(minbox, a.project_id, 'Gauge thing')
  await page.goto(minbox.url)
  const row = page.locator(`[data-testid="task-row"][data-task="${t.id}"]`)
  await expect(row).toContainText('Gauge thing')

  await row.hover()
  await row.getByTestId('task-row-more').click()
  await page.getByTestId('menu-rename-task').click()
  const input = page.getByTestId('rename-task-input')
  await expect(input).toHaveValue('Gauge thing')
  await input.fill('Fix the gauge reading')
  await input.press('Enter')
  await expect(row).toContainText('Fix the gauge reading')
  await expect.poll(async () => (await board(minbox)).tasks.find((x: any) => x.id === t.id)?.title).toBe('Fix the gauge reading')

  // Right-click opens the same menu.
  await row.locator('.v-line').click({ button: 'right' })
  await expect(page.getByTestId('task-row-menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('task-row-menu')).toHaveCount(0)

  // E on the focused row.
  for (let i = 0; i < 5; i++) {
    if ((await page.locator(`[data-testid="task-row"][data-task="${t.id}"].focus`).count()) > 0) break
    await page.keyboard.press('j')
  }
  await expect(row).toHaveClass(/focus/)
  await page.keyboard.press('e')
  await input.fill('Gauge reading off by one')
  await page.getByTestId('rename-task-save').click()
  await expect(row).toContainText('Gauge reading off by one')

  // A rename made elsewhere (the API, as another browser would) shows up without a reload.
  await api(minbox, 'PATCH', `/api/v3/tasks/${t.id}`, { title: 'Renamed elsewhere' })
  await expect(row).toContainText('Renamed elsewhere')
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test('the task view header renames the task', async ({ page, minbox }) => {
    const a = await startAgent(minbox, 'alpha')
    const t = await newTask(minbox, a.project_id, 'Phone task')
    await page.goto(minbox.url + `/#v=task&k=${t.id}`)
    await expect(page.getByTestId('task-title')).toHaveText('Phone task')
    await page.getByTestId('task-rename').tap()
    const input = page.getByTestId('task-title-input')
    await expect(input).toBeFocused()
    await input.fill('Phone task, renamed')
    await input.press('Enter')
    await expect(page.getByTestId('task-title')).toHaveText('Phone task, renamed')
    await expect.poll(async () => (await api(minbox, 'GET', `/api/v3/tasks/${t.id}`)).task.title).toBe('Phone task, renamed')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  })
})
