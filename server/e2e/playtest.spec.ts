import { test, expect, type Page } from '@playwright/test';

function trackBadResponses(page: Page): string[] {
  const badResponses: string[] = [];
  page.on('response', (res) => {
    if (res.status() === 401 || res.status() >= 500) {
      badResponses.push(`${res.status()} ${res.request().method()} ${res.url()}`);
    }
  });
  return badResponses;
}

/** Logs a fresh account in via the dev magic-link flow and returns its captainId. */
async function signIn(page: Page): Promise<string> {
  await page.goto('/');

  const email = `pw-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  await page.locator('#auth-email').fill(email);
  await page.locator('#btn-request-link').click();

  // Dev mode auto-fills the magic-link token once the request completes.
  await expect(page.locator('#auth-token')).not.toHaveValue('');
  // This is the request that failed before the fix: the session cookie from
  // /auth/verify must actually persist (not Max-Age=0) so the very next
  // authenticated call succeeds instead of 401ing.
  const [verifyResponse, meResponse] = await Promise.all([
    page.waitForResponse((res) => res.url().includes('/auth/verify')),
    page.waitForResponse((res) => res.url().includes('/captains/')),
    page.locator('#btn-verify').click(),
  ]);
  expect(meResponse.status(), 'first authenticated request after login must not 401').toBe(200);
  const { captainId } = await verifyResponse.json();

  // Boot panel appears if the galaxy hasn't been initialized yet; if it was
  // already initialized (e.g. by an earlier run against the same local D1),
  // the app skips straight to #game and this click is a harmless no-op timeout.
  await page.locator('#btn-boot').click({ timeout: 3_000 }).catch(() => {});
  await expect(page.locator('#game')).toBeVisible({ timeout: 10_000 });

  return captainId as string;
}

/**
 * Drives the real playtest SPA end-to-end: magic-link login, galaxy
 * bootstrap, and the dock/market/travel loop. Fails on any 401/500 seen
 * anywhere during the run, since those indicate a broken session or a
 * server-side crash rather than an expected game-rule rejection (which
 * the app surfaces as 400s with a `code`).
 */
test('sign in and play the dock/market/travel loop without 401s or 500s', async ({ page }) => {
  // Driving travel all the way to docking (below) can take longer than the
  // default per-test timeout, especially if an ambient encounter interrupts
  // the approach and needs a few extra rounds to resolve.
  test.setTimeout(60_000);
  const badResponses = trackBadResponses(page);
  await signIn(page);

  // The SPA always probes /auth/me on initial load to resume an existing
  // session; a 401 there (no session yet) is expected, not a bug. Only
  // responses from this point on — once we're actually logged in — count
  // toward the blanket "no 401/500 in general use" check below.
  badResponses.length = 0;

  await expect(page.locator('#status-bar')).toContainText('Credits');

  // Market: buy one unit of the first available good and confirm the trade
  // actually moved credits (not just that the request succeeded) — a toast
  // saying "Bought" is not proof the ledger changed.
  await page.locator('[data-tab="market"]').click();
  const buyButton = page.locator('[data-buy]:not([disabled])').first();
  await expect(buyButton).toBeVisible();
  const creditsBefore = Number(
    (await page.locator('#status-bar').innerText()).match(/Credits\s*\n?\s*(\d+)/)?.[1],
  );
  const [tradeResponse] = await Promise.all([
    page.waitForResponse((res) => res.url().includes('/trade')),
    buyButton.click(),
  ]);
  const tradeBody = await tradeResponse.json();
  await expect(page.locator('#toast')).toContainText('Bought');
  expect(tradeBody.captain.credits, 'trade must actually deduct credits').toBeLessThan(creditsBefore);
  await expect
    .poll(async () => {
      const text = await page.locator('#status-bar').innerText();
      return Number(text.match(/Credits\s*\n?\s*(\d+)/)?.[1]);
    })
    .toBe(tradeBody.captain.credits);

  // Dock: attempt a refuel (may be rejected as "tanks full" — that's a
  // legitimate 400, not a bug).
  await page.locator('[data-tab="dock"]').click();
  await page.locator('#btn-refuel').click();
  await page.waitForTimeout(300);

  // Travel: start a jump and keep advancing/resolving encounters until the
  // captain actually docks at the destination — advancing a couple of ticks
  // and stopping (the old behavior) never proved travel actually completes.
  await page.locator('[data-tab="travel"]').click();
  const destButton = page.locator('[data-dest]').first();
  await expect(destButton).toBeVisible();
  const destinationSystemId = await destButton.getAttribute('data-dest');
  await destButton.click();

  await expect(page.locator('#btn-advance')).toBeVisible({ timeout: 10_000 });

  let docked = false;
  for (let i = 0; i < 40 && !docked; i++) {
    // An ambient encounter can interrupt travel at any tick; resolve it with
    // a safe, always-legal action so travel can keep progressing toward the
    // destination instead of stalling (encounter mechanics themselves are
    // covered by the dedicated test below). Use count() rather than a
    // click()-with-timeout probe: clicking a locator that currently matches
    // nothing makes Playwright poll for it to appear for the full timeout,
    // which — multiplied over ~20 approach ticks — blows well past the test
    // timeout even though there was never anything to click.
    const policeAction = page.locator('#police-encounter:not(.hidden) [data-police]').first();
    if (await policeAction.count()) {
      await policeAction.click().catch(() => {});
      await page.waitForTimeout(200);
      continue;
    }
    const shipAction = page.locator('#encounter:not(.hidden) [data-act]').first();
    if (await shipAction.count()) {
      await shipAction.click().catch(() => {});
      await page.waitForTimeout(200);
      continue;
    }
    if (!(await page.locator('#btn-advance').count())) {
      await page.waitForTimeout(200);
      continue;
    }
    try {
      const [advanceResponse] = await Promise.all([
        page.waitForResponse((res) => res.url().includes('/travel/advance'), { timeout: 3_000 }),
        page.locator('#btn-advance').click({ timeout: 2_000 }),
      ]);
      const advanceBody = await advanceResponse.json();
      if (advanceBody.result?.docked) docked = true;
    } catch {
      await page.waitForTimeout(200);
    }
  }

  expect(docked, 'captain should actually dock at the destination within the approach window').toBe(true);
  await expect(page.locator('#status-bar')).toContainText(destinationSystemId!);
  await expect(page.locator('[data-tab="dock"]')).toBeVisible();

  expect(badResponses, `unexpected 401/500 responses:\n${badResponses.join('\n')}`).toEqual([]);
});

/**
 * Encounters (police stops and ship-to-ship contact) are the other major
 * branch of "general use" and weren't covered above, since they only trigger
 * randomly during travel. `/admin/seed-traffic` is a dev-only endpoint built
 * for exactly this: force an NPC into the player's route deterministically
 * so the encounter view/action endpoints can be exercised directly.
 */
test('ship encounter view and first action succeed without 401s or 500s', async ({ page }) => {
  const badResponses = trackBadResponses(page);
  const captainId = await signIn(page);
  badResponses.length = 0;

  await page.locator('[data-tab="travel"]').click();
  const destButton = page.locator('[data-dest]').first();
  await expect(destButton).toBeVisible();
  const destinationSystemId = await destButton.getAttribute('data-dest');
  await destButton.click();
  await expect(page.locator('#btn-advance')).toBeVisible({ timeout: 10_000 });

  const routeArea = `${destinationSystemId}:approach`;
  const seedResponse = await page.request.post('/admin/seed-traffic', {
    data: { systemId: destinationSystemId, routeArea, humanCaptainId: captainId },
  });
  expect(seedResponse.status(), 'seeding a forced NPC encounter must not error').toBe(200);
  const { encounterId } = await seedResponse.json();
  expect(encounterId).toBeTruthy();

  // Reload so the SPA's session-resume path (GET /captains/:id) picks up the
  // now-active encounter and shows the right panel — mirrors a player
  // reopening the app mid-encounter.
  await page.reload();

  // Both panels always exist in the DOM (toggled via a `hidden` class), so
  // `.or()` can't disambiguate them by visibility alone — poll each directly.
  await expect(async () => {
    const shown = await Promise.all([
      page.locator('#encounter').isVisible(),
      page.locator('#police-encounter').isVisible(),
    ]);
    expect(shown.some(Boolean)).toBe(true);
  }).toPass({ timeout: 10_000 });

  const actionButton = page
    .locator('#encounter:not(.hidden) [data-act], #police-encounter:not(.hidden) [data-police]')
    .first();
  await expect(actionButton).toBeVisible();
  const [actionResponse] = await Promise.all([
    page.waitForResponse((res) => res.url().includes('/action') || res.url().includes('/police/respond')),
    actionButton.click(),
  ]);
  expect(actionResponse.status(), 'submitting the first encounter action must not error').toBe(200);

  expect(badResponses, `unexpected 401/500 responses:\n${badResponses.join('\n')}`).toEqual([]);
});
