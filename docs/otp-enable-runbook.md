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

`OTP_SMS_DAILY_BUDGET` is the hard stop. A Redis counter, `otp:budget:count:<YYYY-MM-DD>` (the
business day in Asia/Kolkata), is incremented before the provider is called, so two requests that
arrive together cannot both slip under the limit (decision 0053). The increment that takes the day
past the budget is refused with **503**, one `SMS_BUDGET_EXHAUSTED` alert is recorded, the breaker
`otp:budget:closed:<YYYY-MM-DD>` latches, and every further request answers 503 until midnight IST.
`sms_cost_ledger` stays the record of what was actually sent; the counter is the gate. Start with
expected signups × 3 and watch it.

The budget is a cliff: once it trips, mobile sign-in and sign-up stop for **every** user until
midnight, not only for whoever spent it. So alert on it rather than discovering it from support
messages. Read both counters without touching the audit table:

```
GET redis: otp:budget:count:<YYYY-MM-DD>                    # messages attempted today
GET redis: otp:alerts:SMS_BUDGET_EXHAUSTED:<YYYY-MM-DD>     # non-zero: the budget has tripped
GET redis: otp:budget:closed:<YYYY-MM-DD>                   # non-zero: codes are paused today
```

Alert when the count passes about 80% of the budget — that is a capacity decision either way — and
page when `SMS_BUDGET_EXHAUSTED` becomes non-zero. The remedy is to raise `OTP_SMS_DAILY_BUDGET` and
redeploy (the new value applies at once) or to accept OTP being down until midnight. Do not delete
`otp:budget:closed:<day>` to "test" the reset: that defeats the stop (decision 0054).

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

## 6b. Turning OTP off again

Flipping `OTP_ENABLED` back to false is one variable and a redeploy — and it is the moment a
small group of accounts needs help. Read this before you do it.

**Who is stranded.** An account created from a mobile number has no email address and no
password anybody knows: the stored hash is of a random value the platform generated
(decision 0050). While OTP is on, that account proves itself for a sensitive change with a code
sent to its own number — changing the password, signing out the other sessions, deactivating,
adding or removing an identifier. With the switch off, every OTP route answers 404, so no code
can be sent and those changes cannot be confirmed. The account can still sign in (with a code,
before the switch is flipped) but cannot change anything that asks for proof.

**The recovery path, in order of preference:**

1. **Before the switch goes off**, ask those users to add an email address from `/account`
   (the "Send confirmation code" flow, then the mailed link). An account with an email has
   the password reset path and needs nothing else.
2. **Password reset by email**, for an account that has one: `/forgot-password`, open the
   mailed link, set a password, and from then on the password is the proof.
3. **Administrator-assisted**, for an account with no email: there is no admin screen that
   sets a password today. The operator's path is a database intervention — attach an email
   through the ordinary linking flow once OTP is back on for one deploy, or write a fresh
   `password_hash` with the API's own `hashPassword` and audit it — and it is recorded as an
   owed admin feature in `PROGRESS.md`. Treat it as an incident procedure, not routine support:
   it bypasses the proof the platform normally requires.

**So the order is: add the emails, then flip the switch.** If that was missed, turn
`OTP_ENABLED` back on for one deploy, let the affected users link an email or set a password,
then turn it off again. Do not delete an account to solve this.

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
