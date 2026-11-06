import { Body, Controller, Get, Header, HttpCode, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
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
import { requestMeta, type RequestLike } from '../auth/request';
import { parseUuid } from '../auth/validation';
import { QuestionsService, type QuestionListResult, type QuestionView } from './questions.service';
import { parseQuestionBody, parseQuestionQuery } from './validation';

/**
 * Question authoring for editors who hold the right flags, and for administrators.
 *
 * Reading needs `content.read` (the editor role carries it); writing needs
 * `content.write` (the manage-questions flag); publishing needs `content.publish`, which the
 * EDITOR role carries — publishing a question is a content action. Publishing a *test* is
 * `tests.publish`, an Administrator's alone (decision 0069). Ownership is checked in the
 * service.
 */
@ApiTags('questions')
@Controller('v1/questions')
export class QuestionsController {
  constructor(@Inject(QuestionsService) private readonly questions: QuestionsService) {}

  @RequirePermissions('content.read')
  @Get()
  @ApiOperation({ summary: 'Questions this caller may see, filtered and paged' })
  @ApiOkResponse({ description: 'A page of questions with their current version' })
  async list(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<QuestionListResult> {
    return this.questions.list(actor, parseQuestionQuery(query));
  }

  @RequirePermissions('content.read')
  @Get('export')
  @Header('content-type', 'text/csv; charset=utf-8')
  @ApiOperation({ summary: 'Export the questions this caller may see as CSV' })
  @ApiOkResponse({ description: 'A CSV document; the export is audited' })
  async export(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: Record<string, string | string[] | undefined>,
    @Req() request: RequestLike,
  ): Promise<string> {
    return this.questions.exportCsv(actor, parseQuestionQuery(query), requestMeta(request));
  }

  @RequirePermissions('content.read')
  @Get(':id')
  @ApiOperation({ summary: 'One question with its current version and options' })
  @ApiOkResponse({ description: 'The question' })
  @ApiNotFoundResponse({ description: 'No such question, or it belongs to somebody else' })
  async get(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string): Promise<QuestionView> {
    return this.questions.get(actor, parseUuid(id, 'question id'));
  }

  @RequirePermissions('content.write')
  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a question as a draft' })
  @ApiCreatedResponse({ description: 'The new draft' })
  @ApiBadRequestResponse({ description: 'The body, the answer key or the catalog rows are invalid' })
  @ApiForbiddenResponse({ description: 'The caller cannot author content' })
  async create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() body: unknown,
    @Req() request: RequestLike,
  ): Promise<QuestionView> {
    return this.questions.create(actor, parseQuestionBody(body), requestMeta(request));
  }

  @RequirePermissions('content.write')
  @Patch(':id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Save a draft, creating a new version when the last one is published' })
  @ApiOkResponse({ description: 'The saved draft' })
  @ApiNotFoundResponse({ description: 'No such question, or it belongs to somebody else' })
  async save(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: RequestLike,
  ): Promise<QuestionView> {
    return this.questions.saveDraft(actor, parseUuid(id, 'question id'), parseQuestionBody(body), requestMeta(request));
  }

  @RequirePermissions('content.publish')
  @Post(':id/publish')
  @HttpCode(200)
  @ApiOperation({ summary: 'Publish the current draft, freezing that version' })
  @ApiOkResponse({ description: 'The question, now published' })
  @ApiBadRequestResponse({ description: 'The answer key is incomplete, or the version is already published' })
  async publish(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Req() request: RequestLike,
  ): Promise<QuestionView> {
    return this.questions.publish(actor, parseUuid(id, 'question id'), requestMeta(request));
  }
}
