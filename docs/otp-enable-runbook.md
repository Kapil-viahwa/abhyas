# Enabling mobile OTP

Mobile OTP is built and shipped **disabled**. This is the runbook for turning it on later, in
the order the steps have to happen, with what to check after each one.

The switch is `OTP_ENABLED`, default false. While it is off: every OTP route answers **404**,
the web app shows no mobile sign-up, sign-in or linking UI, and the API constructs no SMS
provider at all (decision 0048). Turning it on is an environment change plus one setting, not a
code change.

## 0. Before you start

- The OTP service, the mobile sign-up, sign-in and linking flows, and the web screens are
  built (Phase 2c items 1–4). The manual staging test in step 7 is still launch-blocking and
  cannot be proven in CI; it is recorded in `docs/ROADMAP.md` with the other blockers.
- Never put a provider key, DLT password or sender secret in the repository. They go into
  GitHub encrypted secrets (for CI, which never sends production SMS) and into the server's
  environment (for production), and `docker-compose.prod.yml` requires each one by name.

## 1. Buy a provider and register for DLT (India)

Every transactional SMS sent to an Indian number must come from a DLT-registered entity with an
approved template. You need, from the provider's portal or from the operator's DLT portal:

| Item | Where it comes from | Goes into |
| --- | --- | --- |
| Entity id | DLT portal registration for the company | `OTP_DLT_ENTITY_ID` |
| Sender id (6 characters) | DLT portal, per header you registered | `OTP_SENDER_ID` |
| Template id | An approved template whose body contains the code placeholder | `OTP_TEMPLATE_ID` |
| Gateway URL | The provider's HTTP send endpoint | `OTP_GATEWAY_URL` |
| Auth header name and value | The provider's API key or token header | `OTP_GATEWAY_AUTH_HEADER`, `OTP_GATEWAY_AUTH_VALUE` |

The template body must match, word for word, what `OtpService` sends:

```
Your Abhyas verification code is {code}. It expires in 5 minutes. Do not share it.
```

`{code}` is the DLT placeholder; the provider substitutes it. If your provider's API takes the
code as a separate field, use `docs/sms-provider.md` to write a vendor adapter rather than
bending the generic gateway.

## 2. Configure the gateway

`SMS_PROVIDER` must be `http`: only the generic adapter exists. The gateway is an SSRF seam and
is guarded twice (decision 0048), so it must satisfy the guard or the process will refuse to
boot:

- `OTP_GATEWAY_URL` must be **https** in production, and its host must resolve only to public
  addresses. Loopback, private, link-local, CGNAT (`100.64.0.0/10`), multicast and the cloud
  metadata address are refused, including numeric and IPv4-mapped forms. Name the public
  hostname, never an IP.
- `OTP_GATEWAY_BODY_TEMPLATE` is JSON with `{{to}}`, `{{body}}` and `{{templateId}}`.
- `OTP_GATEWAY_TIMEOUT_MS` is bounded to 1000–30000; 5000 is a sensible start.
- Redirects are not followed and a 3xx is a delivery failure. A gateway that redirects is
  misconfigured, not "almost working".

## 3. Set the secrets and the policy values

```bash
OTP_ENABLED=true
OTP_HMAC_SECRET=<32+ random characters, generated on the server, never committed>
OTP_SENDER_ID=<DLT sender id>
OTP_DLT_ENTITY_ID=<DLT entity id>
OTP_TEMPLATE_ID=<approved template id>
OTP_GATEWAY_URL=https://<provider host>/<send path>
OTP_GATEWAY_AUTH_HEADER=<header name>
OTP_GATEWAY_AUTH_VALUE=<key>
OTP_GATEWAY_BODY_TEMPLATE={"to":"{{to}}","message":"{{body}}","template":"{{templateId}}"}
OTP_GATEWAY_TIMEOUT_MS=5000
OTP_ALLOWED_COUNTRY_CODES=+91
OTP_SMS_DAILY_BUDGET=<messages per Asia/Kolkata day>
```

Set them in the server's environment, and in the repository's GitHub encrypted secrets if you
want the deploy job to carry them. `OTP_HMAC_SECRET` is not recoverable: rotating it invalidates
only the codes that are in flight, which is a five-minute window.

## 4. Pick the daily budget

`OTP_SMS_DAILY_BUDGET` is the hard stop: once that many messages have been handed to the
provider in one business day (counted from `sms_cost_ledger`, Asia/Kolkata), the breaker latches
for the rest of the day, one `SMS_BUDGET_EXHAUSTED` alert row is written, and every further
request answers 503 until midnight IST. Start with expected signups × 3 and watch it.

Read the alert counter without touching the audit table:

```
GET redis: otp:alerts:SMS_BUDGET_EXHAUSTED:<YYYY-MM-DD>
```

## 5. Turn the switch on

One variable is a test fixture and must never appear here: `OTP_FAKE_FIXED_CODE` makes every
code the same six digits so the browser suite can type one it knows (decision 0051). It is
honoured only by the fake provider outside production, and the production boot refuses it — but
do not set it, do not copy `docker-compose.otp.yml` into any deployment, and treat its presence
as an incident.

Deploy with `OTP_ENABLED=true`. The API and the web tier must be deployed together: a web tier
that still hides the mobile UI hides working routes, which is harmless, but an API with the
switch off answers 404 to a web tier that shows the buttons, which is confusing.

The boot is the check. With the switch on, production refuses to start if the provider is fake
or console, if `OTP_HMAC_SECRET` is missing, short or a well-known default, if the sender id, DLT
entity id or template id is missing, or if the gateway URL is empty, not https, or has no body
template. Read the failure line, fix the value named in it, and boot again.

## 6. Flip the signup requirement

`signup_grant_requirement` is a setting row seeded with `email` (the value that matches a
platform where signing up means an email address). Once OTP is on and you want the signup coin
grant to require a **verified mobile number** instead, change it to `mobile` from
`/admin/settings`; the change is audited like every other setting, and the database refuses any
value that is not `email` or `mobile`. The coin grant itself is Phase 5: this phase only records
which contact must be verified.

## 7. Verification checklist

On staging, with a real provider and a real phone:

1. Request a code; the SMS arrives within a minute, from the approved sender id, with the
   approved wording.
2. Verify it; you are signed in, and the account page shows the session.
3. Verify the same code again → refused (single use).
4. Five wrong codes → refused, and the sixth with the correct code also refused (spent).
5. Request a second code immediately → 429 with a retry-after; wait, then it succeeds.
6. Request a fourth code in an hour for one number → 429.
7. Sign in for a number with no account → the same "accepted" answer as a number that has one,
   and no code-shaped difference in timing you can measure.
8. Set `OTP_SMS_DAILY_BUDGET=1`, exhaust it, and confirm 503 plus one alert row.
9. Sign up a fresh number with a code; the account has no email address, and the admin list
   shows "No email linked" rather than a blank or the word "null".
10. Change that account's password with a re-authentication code from its own number, then
    deactivate it the same way; both end the sessions they must.
11. Add an email address from the account page (signed in, confirmed from the mailed link), then
    try to attach a number that belongs to another account → refused, generically, and audited.
    Remove the number while an email exists → allowed; try to remove it when it is the only
    identifier → refused.
12. Roll `OTP_ENABLED` back to false, redeploy, and confirm every OTP route answers 404, that
    `/login/mobile` is a 404 page, and that the sign-in page has no mobile link. Email linking
    must keep working with the switch off.

Record the date and the result in `PROGRESS.md`. Until that has been done, OTP stays off in
production even if everything above is configured.
