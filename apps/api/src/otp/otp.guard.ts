import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';

import { loadConfig } from '../config/config';

/**
 * The master switch, in front of every OTP route.
 *
 * With `OTP_ENABLED=false` the routes answer **404**, not 403: the platform does not
 * advertise a capability it has switched off. Hiding the web screens is not enough — the API
 * has to refuse as well — and this guard is what makes the two agree.
 */
@Injectable()
export class OtpGuard implements CanActivate {
  private readonly enabled: boolean;

  constructor() {
    this.enabled = loadConfig(process.env).OTP_ENABLED;
  }

  canActivate(): boolean {
    if (!this.enabled) {
      throw new NotFoundException('Not found');
    }

    return true;
  }
}
