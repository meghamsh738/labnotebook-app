import { test, expect } from '@playwright/test'
import { buildUiReviewFixture, installUiReviewFixture } from '../scripts/ui-review-fixture.mjs'

test('UI review fixture loads on the normal route and stays isolated from dev preview', async ({ browser }) => {
  const fixture = buildUiReviewFixture()

  const fixtureContext = await browser.newContext()
  await installUiReviewFixture(fixtureContext, fixture)
  const fixturePage = await fixtureContext.newPage()
  await fixturePage.goto('/')

  await expect(fixturePage.getByTestId(`entry-list-item-${fixture.ids.populatedEntry}`)).toBeVisible()
  const connectedAccount = await fixturePage.evaluate(() => {
    const raw = window.localStorage.getItem('labnote.connected.googleDrive')
    return raw ? JSON.parse(raw).connectedAccount : null
  })
  expect(connectedAccount).toMatchObject({
    email: 'researcher@example.invalid',
    subject: 'local-workspace',
    storageScope: 'local-workspace',
  })
  await fixtureContext.close()

  const previewContext = await browser.newContext()
  await installUiReviewFixture(previewContext, fixture)
  const previewPage = await previewContext.newPage()
  await previewPage.goto('/?devDrivePreview=1')

  await expect(previewPage.getByTestId(`entry-list-item-${fixture.ids.populatedEntry}`)).toHaveCount(0)
  await expect(previewPage.getByTestId('entry-view')).toBeVisible()
  await previewContext.close()
})
