import { expect, sql, test, unique } from './fixtures';

// Scenario 1, first half: a new owner signs up, creates the restaurant and
// lands in the dashboard. (The menu step that follows belongs to Agent B1.)
test('sign up → create restaurant → dashboard', async ({ page }) => {
  const email = `${unique('owner')}@example.test`;
  const name = `Olive ${unique('r').slice(-6)}`;
  await page.goto('/');
  await page.locator('.lp-cta a[href="/signup"]').click();
  await expect(page).toHaveURL(/\/signup$/);
  await page.getByLabel('Full name').fill('Mona Adel');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/onboarding$/);

  await page.getByLabel('Restaurant name').fill(name);
  await page.getByLabel('Arabic name (optional)').fill('غرفة الزيتون');
  await page.getByLabel('First branch name').fill('Zamalek');
  await page.getByLabel('City').fill('Cairo');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/dashboard\/[0-9a-f-]{36}\/menu\?welcome=1$/);
  const orgId = page.url().split('/dashboard/')[1]!.split('/')[0]!;

  const [org] = await sql('select name, status, country from organizations where id = $1', [orgId]);
  expect(org).toMatchObject({ name, status: 'onboarding', country: 'EG' });
  const [site] = await sql('select status from websites where org_id = $1', [orgId]);
  expect(site.status).toBe('draft');

  // The dashboard shell loads for the new owner with the Studio pages available.
  await page.goto(`/dashboard/${orgId}`);
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).or(page.locator('aside.sidebar'))).toBeVisible();
  await expect(page.locator('aside.sidebar')).toContainText(name);
  await page.locator('aside.sidebar a[href$="/website"]').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Website' })).toBeVisible();
  await expect(page.getByText('Not published yet')).toBeVisible();
});
