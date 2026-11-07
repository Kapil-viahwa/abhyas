import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { ApiCreatedResponse, ApiForbiddenResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Authenticated, CurrentUser, type AuthenticatedUser } from '../auth/access';
import { requestMeta, type RequestLike } from '../auth/request';
import { parseUuid } from '../auth/validation';
import {
  EnrollmentsService,
  type EnrollmentPage,
  type EnrollmentView,
  type StudentTestPage,
  type StudentTestView,
} from './enrollments.service';
import {
  parseEnrollBody,
  parseEnrollQuery,
  parseEnrollmentPageQuery,
  parseIdempotencyKey,
  parseStudentCatalogQuery,
} from './validation';

/**
 * The student catalog: the papers that are for sale, and one of them.
 *
 * `@Authenticated` rather than a permission: every signed-in account may read the catalog and
 * its own state. There is no `userId` anywhere — the account is the session's — and a request
 * that carries one in the body or the query is refused with 400 rather than ignored. No route
 * here ever selects a question, an option, an answer key or a creator.
 */
@ApiTags('tests')
@Controller('v1/tests')
export class StudentTestsController {
  constructor(@Inject(EnrollmentsService) private readonly enrollments: EnrollmentsService) {}

  @Authenticated()
  @Get()
  @ApiOperation({ summary: 'Published papers that may be enrolled in, with my own state' })
  @ApiOkResponse({ description: 'One page of published papers, priced, with my enrollment state' })
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<StudentTestPage> {
    return this.enrollments.list(user, parseStudentCatalogQuery(query));
  }

  @Authenticated()
  @Get(':id')
  @ApiOperation({ summary: 'One published paper, with its pattern and my own state' })
  @ApiOkResponse({ description: 'The paper, without questions, options or an answer key' })
  @ApiNotFoundResponse({ description: 'No such paper, or it is not published' })
  async get(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<StudentTestView> {
    return this.enrollments.get(user, parseUuid(id, 'test id'));
  }

  @Authenticated()
  @Post(':id/enroll')
  @HttpCode(201)
  @ApiOperation({ summary: 'Buy one attempt of one paper, once per Idempotency-Key' })
  @ApiCreatedResponse({ description: 'The enrollment; a replayed key returns the first one unchanged' })
  @ApiForbiddenResponse({ description: 'The account is not active' })
  @ApiNotFoundResponse({ description: 'No such paper, or it is not published' })
  async enroll(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
    @Query() query: Record<string, string | string[] | undefined>,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestLike,
  ): Promise<EnrollmentView> {
    const testId = parseUuid(id, 'test id');
    parseEnrollQuery(query);
    parseEnrollBody(body);

    return this.enrollments.enroll(user, testId, parseIdempotencyKey(idempotencyKey), requestMeta(request));
  }
}

/**
 * A student's own enrollments.
 *
 * The same rule as the catalog: the account is the session's, and the answer is a whitelist of
 * the caller's own rows — newest first, paged, and never another student's.
 */
@ApiTags('tests')
@Controller('v1/enrollments')
export class EnrollmentsController {
  constructor(@Inject(EnrollmentsService) private readonly enrollments: EnrollmentsService) {}

  @Authenticated()
  @Get('me')
  @ApiOperation({ summary: 'My enrollments, newest first' })
  @ApiOkResponse({ description: 'One page of my enrollments with the paper each bought' })
  async mine(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<EnrollmentPage> {
    return this.enrollments.mine(user, parseEnrollmentPageQuery(query));
  }
}
