import type { NextConfig } from 'next';

import { headerRules } from './src/lib/security-headers';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The security headers live in one testable module rather than inline here.
  async headers() {
    return headerRules();
  },
};

export default nextConfig;
