import type { NextConfig } from 'next';

import { headerRules } from './src/lib/security-headers';

// The storage origin question images are loaded from. Unset means the policy has no
// third-party image host at all, which is the default for every environment.
const mediaOrigin = process.env.MEDIA_ORIGIN ?? '';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The security headers live in one testable module rather than inline here.
  async headers() {
    return headerRules(mediaOrigin);
  },
};

export default nextConfig;
