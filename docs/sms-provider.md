# SMS providers

Phase 2c ships the OTP machinery switched **off**. This note records what a real SMS
provider needs, so turning it on is a configuration job plus one adapter, not a redesign.

## The seam

`apps/api/src/otp/sms-provider.ts` defines one interface:

```
SmsProvider.send({ to, body, templateId }) -> { providerMessageId }
```

- `FakeSmsProvider` — development and CI only. Keeps messages in an in-memory outbox and
  refuses to be constructed when `NODE_ENV=production`.
- `HttpSmsProvider` — the generic gateway: one POST, a configurable URL, one auth header, a
  JSON body template with `{{to}}`, `{{body}}` and `{{templateId}}`, and a timeout that
  aborts the request. Values are JSON-escaped before substitution.
- `createSmsProvider()` returns **`null` when `OTP_ENABLED` is false**. Nothing is built, so
  nothing can send.

## Writing a vendor adapter

A vendor adapter is one class implementing `SmsProvider`, with a unit test against a local
mock server like the generic one has:

1. **Map the vendor's request shape.** Most Indian vendors take a JSON POST with
   `sender`, `template_id`, `to`, and either numbered variables or a plain message.
2. **Read the vendor's success signal.** Some answer `200` with a body that still contains
   an error code; treat that as a failure.
3. **Return the vendor's message id**, which goes into `sms_cost_ledger.provider_message_id`.
4. **Never log the body.** The OTP digest is sensitive; a body in a log is a leaked code.
5. **Keep the timeout.** Same abort-on-deadline behaviour as `HttpSmsProvider`.

## India requirements (DLT)

India requires registration before a transactional SMS can be delivered:

| Item | What it is | Where it goes |
| --- | --- | --- |
| DLT entity registration | The business entity registered on a DLT portal (Jio/Airtel/Vi/BSNL) | `SMS_DLT_ENTITY_ID` |
| Sender id / header | Six characters, e.g. `ABHYAS`, tied to the entity | `SMS_SENDER_ID` |
| Template registration | Each message text is approved individually and gets an id | `SMS_TEMPLATE_ID_OTP` |
| Content rules | No URLs, no promotional text, no variables in the wrong places; variables are `{#var#}` in DLT terms | Template body |

Consequences the code already respects:

- The message body must be **exactly** the approved template with variables filled, so the
  body is built from the template id rather than written ad hoc.
- A template is per purpose: signup, sign-in and linking can have different approved texts,
  which is why `purpose` is stored on `otp_requests`.
- A sender id is per entity; production refuses a boot without one.

## Configuration (when the switch is turned on)

| Variable | Meaning |
| --- | --- |
| `OTP_ENABLED` | `true` turns every OTP route on; `false` makes them 404 |
| `SMS_PROVIDER` | `fake` (dev and CI only) or `http` (the generic gateway) |
| `SMS_GATEWAY_URL` | The vendor endpoint |
| `SMS_GATEWAY_AUTH_HEADER` / `SMS_GATEWAY_AUTH_VALUE` | The header the vendor expects, value from GitHub encrypted secrets |
| `SMS_GATEWAY_BODY_TEMPLATE` | JSON template with the three placeholders |
| `SMS_SENDER_ID`, `SMS_DLT_ENTITY_ID`, `SMS_TEMPLATE_ID_OTP` | DLT registration values |
| `SMS_DAILY_BUDGET` | Messages per day before the circuit breaker opens |
| `OTP_HMAC_SECRET` | The server secret the codes are HMAC-ed with; never in git |

The runbook for the actual cutover is `docs/otp-enable-runbook.md` (item 5 of the phase).


## What the platform does around a provider (phase 2c)

Before a provider sees a message, `OtpService` has already:

- checked the human challenge, the per-number (3/hour, 8/day), per-IP (10/hour) and per-device
  (5/hour) limits, the escalating resend cooldown, and the daily SMS budget;
- written an `otp_requests` row whose `code_hmac` is the only trace of the code.

After the provider answers, the platform writes one `sms_cost_ledger` row (provider, destination
hash, cost, provider message id). That ledger is what the daily budget counts, so a provider
invoice can be reconciled with something the platform wrote itself.

**The gateway URL is an SSRF seam.** At boot the URL must be https in production and must not
name a private, loopback, link-local, CGNAT, multicast, unspecified or metadata address —
including numeric forms (`127.1`, `0x7f000001`, `2130706433`) and IPv4-mapped IPv6. At send time
DNS is resolved once, *every* answer is checked, and the address that passed is pinned into the
connection through the request's `lookup` option; nothing resolves the name a second time.
Redirects are not followed (a 3xx is a failure), the timeout is bounded per request, and the
answer is read with an 8 KiB cap. A development mock on loopback is allowed outside production
only. Decision 0048 records the reasoning.
