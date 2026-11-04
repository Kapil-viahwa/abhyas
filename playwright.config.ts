import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

/**
 * Two projects, because the master switch is two stacks.
 *
 * The default stack has `OTP_ENABLED=false`, and the `chromium` project proves the mobile
 * screens are hidden and their routes answer 404. The enabled spec needs a stack started
 * with `docker-compose.otp.yml` (fake provider, fixed code — decision 0051), so it is a
 * project of its own and only exists when `E2E_OTP=1` is set for that run. The e2e job runs
 * the two back-to-back: `--project=chromium`, restart the stack, then `--project=otp`.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  // A hung browser fails the run instead of holding the job open; the job has a cap too.
  globalTimeout: process.env.CI ? 8 * 60_000 : 0,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      // Everything except the spec that needs OTP switched on.
      name: 'chromium',
      testIgnore: /otp-enabled\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    ...(process.env.E2E_OTP === '1'
      ? [
          {
            name: 'otp',
            testMatch: /otp-enabled\.spec\.ts/,
            // One stack, one browser, one worker: these flows share its limits.
            timeout: 60_000,
            expect: { timeout: 10_000 },
            use: { ...devices['Desktop Chrome'] },
          },
        ]
      : []),
  ],
});
