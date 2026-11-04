-- Phase 2c, item 2: confirming it is still the account holder before a sensitive change.
--
-- The code that does that is an OTP like any other, so it lives in `otp_requests` with its
-- own purpose; the table's CHECK is the only thing that decides which purposes exist.

ALTER TABLE "otp_requests" DROP CONSTRAINT "otp_requests_purpose_valid";

ALTER TABLE "otp_requests"
    ADD CONSTRAINT "otp_requests_purpose_valid"
    CHECK ("purpose" IN ('SIGNUP', 'LOGIN', 'LINK', 'REAUTH'));
