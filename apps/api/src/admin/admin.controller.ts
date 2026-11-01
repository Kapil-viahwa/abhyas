import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { RequirePermissions } from '../auth/access';

/**
 * The first route that requires a permission, so the matrix is proven end to end:
 * an administrator session passes and a student session is refused. It is replaced
 * by real user management in the next slice; until then it is the honest smoke
 * route for the guard rather than a placeholder without a permission.
 */
@ApiTags('admin')
@Controller('v1/admin')
export class AdminController {
  @RequirePermissions('users.read')
  @Get('ping')
  @ApiOperation({ summary: 'Prove the caller holds users.read' })
  @ApiOkResponse({ description: 'The caller may administer users' })
  ping(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
