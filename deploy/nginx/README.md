# The Abhyas edge

`abhyas.conf` is the Nginx server configuration for the host that fronts the web tier, and
`abhyas-proxy.conf` holds the proxy rules each location includes. `docs/deployment.md` §11 is the
operator's runbook for installing Nginx, issuing the first certificate and checking the result.

- Copy `abhyas.conf` to `/etc/nginx/conf.d/abhyas.conf` and `abhyas-proxy.conf` to
  `/etc/nginx/abhyas-proxy.conf`.
- Replace `__DOMAIN__` with the real host name in `abhyas.conf` before enabling it.
- Nothing here is a certificate or a key: certbot writes those under `/etc/letsencrypt/live/`,
  and they are never committed.
- `.github/workflows/proxy-check.yml` runs the configuration against a stub upstream with a
  throwaway self-signed certificate, and asserts the redirect, the overwritten headers, the
  HSTS header, the TLS floor, the closed default servers, the 404s, the body limit and the rate
  limit.
