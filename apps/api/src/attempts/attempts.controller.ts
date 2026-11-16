import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { Authenticated, CurrentUser, type AuthenticatedUser } from '../auth/access';
import { requestMeta, type RequestLike } from '../auth/request';
import { parseUuid } from '../auth/validation';
import { AttemptsService, type AttemptResultView, type AttemptStartView, type AttemptStateView } from './attempts.service';
import { parseAttemptQuery, parseAttemptStartBody, parseSubmitBody } from './attempts.validation';

/**
 * The student's attempt: one start, its state, one submit and the result.
 *
 * All four are `@Authenticated` and self-only — no `userId` appears in a body, a query or a path,
 * and a row that is not the caller's is a 404. The start response is the only pre-end response
 * that carries the paper, and it carries no answer key; the result is the only response in the
 * whole API that carries one, and only once the caller's own attempt has ended.
 */
@ApiTags('attempts')
@Controller('v1')
export class AttemptsController {
  constructor(@Inject(AttemptsService) private readonly attempts: AttemptsService) {}

  @Authenticated()
  @Post('enrollments/:id/attempt')
  @HttpCode(201)
  @ApiOperation({ summary: 'Start the one attempt this enrollment bought, and receive the paper once' })
  @ApiCreatedResponse({ description: 'The attempt and its questions, without an answer key' })
  @ApiBadRequestResponse({ description: 'A body or query the route does not read, a userId, or a bad id' })
  @ApiNotFoundResponse({ description: 'No such enrollment, or it belongs to another student' })
  async start(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
    @Query() query: Record<string, string | string[] | undefined>,
    @Req() request: RequestLike,
  ): Promise<AttemptStartView> {
    const enrollmentId = parseUuid(id, 'enrollment id');
    parseAttemptQuery(query);
    parseAttemptStartBody(body);

    return this.attempts.start(user, enrollmentId, requestMeta(request));
  }

  @Authenticated()
  @Get('attempts/:id')
  @ApiOperation({ summary: 'My attempt: status and the server’s remaining seconds, never the paper' })
  @ApiOkResponse({ description: 'The attempt state; no questions and no answer data' })
  @ApiNotFoundResponse({ description: 'No such attempt, or it belongs to another student' })
  async state(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<AttemptStateView> {
    parseAttemptQuery(query);
    return this.attempts.state(user, parseUuid(id, 'attempt id'));
  }

  @Authenticated()
  @Get('enrollments/:id/attempt')
  @ApiOperation({ summary: 'The attempt my enrollment has, or null before it starts' })
  @ApiOkResponse({ description: 'The attempt state, or null; never the paper' })
  @ApiNotFoundResponse({ description: 'No such enrollment, or it belongs to another student' })
  async byEnrollment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<{ readonly attempt: AttemptStateView | null }> {
    parseAttemptQuery(query);
    return this.attempts.attemptForEnrollment(user, parseUuid(id, 'enrollment id'));
  }

  @Authenticated()
  @Post('attempts/:id/submit')
  @HttpCode(200)
  @ApiOperation({ summary: 'Submit the answers once; a replay returns the first result unchanged' })
  @ApiOkResponse({ description: 'The result of the attempt' })
  @ApiBadRequestResponse({ description: 'An answer, a question or an option that is not this paper’s' })
  @ApiNotFoundResponse({ description: 'No such attempt, or it belongs to another student' })
  async submit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
    @Query() query: Record<string, string | string[] | undefined>,
    @Req() request: RequestLike,
  ): Promise<AttemptResultView> {
    const attemptId = parseUuid(id, 'attempt id');
    parseAttemptQuery(query);
    const answers = parseSubmitBody(body);

    return this.attempts.submit(user, attemptId, answers, requestMeta(request));
  }

  @Authenticated()
  @Get('attempts/:id/result')
  @ApiOperation({ summary: 'My result and review, only once the attempt has ended' })
  @ApiOkResponse({ description: 'Score, counts, accuracy and the per-question review with the key' })
  @ApiNotFoundResponse({ description: 'No such attempt, or it belongs to another student' })
  async result(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<AttemptResultView> {
    parseAttemptQuery(query);
    return this.attempts.result(user, parseUuid(id, 'attempt id'));
  }
}
