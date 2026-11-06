import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUser, RequirePermissions, type AuthenticatedUser } from '../auth/access';
import { parseUuid } from '../auth/validation';
import { requestMeta, type RequestLike } from '../auth/request';
import { TestsService, type TestListResult, type TestView } from './tests.service';
import {
  parseCreateTestBody,
  parseQuestionOrderBody,
  parseTestQuery,
  parseUpdateTestBody,
} from './validation';

/**
 * Building a paper.
 *
 * Reading needs `tests.read` (the editor role carries it); building needs `tests.write` (the
 * manage-tests flag, or an Administrator). Publishing and archiving are **not** here: they are
 * the Administrator's alone (decision 0069), because the owner decided only an Administrator
 * publishes or archives a test. Ownership is checked in the service, so an editor only ever
 * reads and writes the papers they created.
 */
@ApiTags('tests')
@Controller('v1/editor/tests')
export class EditorTestsController {
  constructor(@Inject(TestsService) private readonly tests: TestsService) {}

  @RequirePermissions('tests.read')
  @Get()
  @ApiOperation({ summary: 'The papers this caller may see, newest first' })
  @ApiOkResponse({ description: 'A page of tests with their current version' })
  @ApiBadRequestResponse({ description: 'An unknown filter, or a value that is not one the filter allows' })
  async list(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<TestListResult> {
    return this.tests.list(actor, parseTestQuery(query));
  }

  @RequirePermissions('tests.read')
  @Get(':id')
  @ApiOperation({ summary: 'One test with its pattern and its ordered questions' })
  @ApiOkResponse({ description: 'The test, with the answer key for an Editor or an Administrator' })
  @ApiNotFoundResponse({ description: 'No such test, or it belongs to somebody else' })
  async get(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string): Promise<TestView> {
    return this.tests.get(actor, parseUuid(id, 'test id'));
  }

  @RequirePermissions('tests.write')
  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a draft paper for an exam the caller may write content for' })
  @ApiCreatedResponse({ description: 'The new draft' })
  @ApiBadRequestResponse({ description: 'The body, the exam or the duration is invalid' })
  @ApiForbiddenResponse({ description: 'The caller cannot build tests' })
  async create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() body: unknown,
    @Req() request: RequestLike,
  ): Promise<TestView> {
    return this.tests.create(actor, parseCreateTestBody(body), requestMeta(request));
  }

  @RequirePermissions('tests.write')
  @Patch(':id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Change a draft, opening a new version when the last one is published' })
  @ApiOkResponse({ description: 'The saved test' })
  @ApiNotFoundResponse({ description: 'No such test, or it belongs to somebody else' })
  @ApiBadRequestResponse({ description: 'The body or the pattern is invalid' })
  async update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: RequestLike,
  ): Promise<TestView> {
    return this.tests.update(actor, parseUuid(id, 'test id'), parseUpdateTestBody(body), requestMeta(request));
  }

  @RequirePermissions('tests.write')
  @Put(':id/questions')
  @HttpCode(200)
  @ApiOperation({ summary: 'Set the paper\u2019s whole question list, in order' })
  @ApiOkResponse({ description: 'The test with its questions at positions 1..n' })
  @ApiBadRequestResponse({ description: 'A question is missing, unpublished, foreign or from another exam' })
  async setQuestions(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: RequestLike,
  ): Promise<TestView> {
    return this.tests.setQuestions(actor, parseUuid(id, 'test id'), parseQuestionOrderBody(body), requestMeta(request));
  }

  @RequirePermissions('tests.write')
  @Post(':id/submit')
  @HttpCode(200)
  @ApiOperation({ summary: 'Hand a complete draft to an Administrator for review' })
  @ApiOkResponse({ description: 'The test, now submitted' })
  @ApiBadRequestResponse({ description: 'The draft has no questions' })
  async submit(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Req() request: RequestLike,
  ): Promise<TestView> {
    return this.tests.submit(actor, parseUuid(id, 'test id'), requestMeta(request));
  }
}

/**
 * The Administrator's two decisions on a test.
 *
 * Both routes require `tests.publish`, which only an Administrator holds: an Editor or a Student
 * calling either is refused with 403 by the guard before the handler runs, whatever flags the
 * editor was given. The database refuses the grant itself as well (decision 0069).
 */
@ApiTags('tests-admin')
@Controller('v1/admin/tests')
export class AdminTestsController {
  constructor(@Inject(TestsService) private readonly tests: TestsService) {}

  @RequirePermissions('tests.publish')
  @Post(':id/publish')
  @HttpCode(200)
  @ApiOperation({ summary: 'Publish the submitted (or revised) version, freezing it' })
  @ApiOkResponse({ description: 'The test, now published' })
  @ApiForbiddenResponse({ description: 'Only an Administrator publishes a test' })
  async publish(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Req() request: RequestLike,
  ): Promise<TestView> {
    return this.tests.publish(actor, parseUuid(id, 'test id'), requestMeta(request));
  }

  @RequirePermissions('tests.publish')
  @Post(':id/archive')
  @HttpCode(200)
  @ApiOperation({ summary: 'Retire a published test; its enrollments stay' })
  @ApiOkResponse({ description: 'The test, now archived' })
  @ApiForbiddenResponse({ description: 'Only an Administrator archives a test' })
  async archive(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Req() request: RequestLike,
  ): Promise<TestView> {
    return this.tests.archive(actor, parseUuid(id, 'test id'), requestMeta(request));
  }
}
