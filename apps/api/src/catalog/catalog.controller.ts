import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiForbiddenResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser, RequirePermissions, type AuthenticatedUser } from '../auth/access';
import { requestMeta, type RequestLike } from '../auth/request';
import { parseUuid } from '../auth/validation';
import {
  CatalogService,
  type CatalogTree,
  type CategoryNode,
  type ExamNode,
  type SubjectNode,
  type TopicNode,
} from './catalog.service';

/**
 * Catalog authoring, for Administrators and for editors who hold `content.write`.
 *
 * The permission gets an editor through the door; the service decides which rows an
 * editor may touch, which is always "the ones I created". Subjects and topics inherit
 * the ownership of their exam, so a foreign exam id is not a way in.
 */
@ApiTags('catalog')
@Controller('v1/catalog')
export class CatalogController {
  constructor(@Inject(CatalogService) private readonly catalog: CatalogService) {}

  @RequirePermissions('content.read')
  @Get('tree')
  @ApiOperation({ summary: 'The catalog tree, including inactive rows' })
  @ApiOkResponse({ description: 'Categories and exams with their subjects and topics' })
  async tree(): Promise<CatalogTree> {
    return this.catalog.tree();
  }

  @RequirePermissions('content.write')
  @Post('categories')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a category or subcategory' })
  @ApiOkResponse({ description: 'The new category' })
  @ApiForbiddenResponse({ description: 'The caller does not hold content.write' })
  async createCategory(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() body: unknown,
    @Req() request: RequestLike,
  ): Promise<CategoryNode> {
    return this.catalog.createCategory(actor, body, requestMeta(request));
  }

  @RequirePermissions('content.write')
  @Patch('categories/:id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rename, reorder, activate or move a category' })
  @ApiOkResponse({ description: 'The updated category' })
  @ApiForbiddenResponse({ description: 'The category belongs to another editor' })
  @ApiNotFoundResponse({ description: 'No such category' })
  async updateCategory(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: RequestLike,
  ): Promise<CategoryNode> {
    return this.catalog.updateCategory(actor, parseUuid(id, 'category id'), body, requestMeta(request));
  }

  @RequirePermissions('content.write')
  @Delete('categories/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete an empty category' })
  @ApiForbiddenResponse({ description: 'The category belongs to another editor' })
  @ApiNotFoundResponse({ description: 'No such category' })
  async deleteCategory(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Req() request: RequestLike,
  ): Promise<void> {
    await this.catalog.deleteCategory(actor, parseUuid(id, 'category id'), requestMeta(request));
  }

  @RequirePermissions('content.write')
  @Post('exams')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create an exam inside a category' })
  @ApiOkResponse({ description: 'The new exam' })
  async createExam(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() body: unknown,
    @Req() request: RequestLike,
  ): Promise<ExamNode> {
    return this.catalog.createExam(actor, body, requestMeta(request));
  }

  @RequirePermissions('content.write')
  @Patch('exams/:id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rename, reorder, describe or activate an exam' })
  @ApiOkResponse({ description: 'The updated exam' })
  @ApiForbiddenResponse({ description: 'The exam belongs to another editor' })
  async updateExam(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: RequestLike,
  ): Promise<ExamNode> {
    return this.catalog.updateExam(actor, parseUuid(id, 'exam id'), body, requestMeta(request));
  }

  @RequirePermissions('content.write')
  @Delete('exams/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete an exam with no subjects' })
  @ApiForbiddenResponse({ description: 'The exam belongs to another editor' })
  async deleteExam(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Req() request: RequestLike,
  ): Promise<void> {
    await this.catalog.deleteExam(actor, parseUuid(id, 'exam id'), requestMeta(request));
  }

  @RequirePermissions('content.write')
  @Post('subjects')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a subject inside one of my exams' })
  @ApiOkResponse({ description: 'The new subject' })
  @ApiForbiddenResponse({ description: 'The exam belongs to another editor' })
  async createSubject(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() body: unknown,
    @Req() request: RequestLike,
  ): Promise<SubjectNode> {
    return this.catalog.createSubject(actor, body, requestMeta(request));
  }

  @RequirePermissions('content.write')
  @Patch('subjects/:id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rename, reorder or activate a subject' })
  @ApiOkResponse({ description: 'The updated subject' })
  @ApiForbiddenResponse({ description: "The subject's exam belongs to another editor" })
  async updateSubject(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: RequestLike,
  ): Promise<SubjectNode> {
    return this.catalog.updateSubject(actor, parseUuid(id, 'subject id'), body, requestMeta(request));
  }

  @RequirePermissions('content.write')
  @Delete('subjects/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a subject with no topics' })
  @ApiForbiddenResponse({ description: "The subject's exam belongs to another editor" })
  async deleteSubject(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Req() request: RequestLike,
  ): Promise<void> {
    await this.catalog.deleteSubject(actor, parseUuid(id, 'subject id'), requestMeta(request));
  }

  @RequirePermissions('content.write')
  @Post('topics')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a topic inside one of my subjects' })
  @ApiOkResponse({ description: 'The new topic' })
  @ApiForbiddenResponse({ description: "The subject's exam belongs to another editor" })
  async createTopic(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() body: unknown,
    @Req() request: RequestLike,
  ): Promise<TopicNode> {
    return this.catalog.createTopic(actor, body, requestMeta(request));
  }

  @RequirePermissions('content.write')
  @Patch('topics/:id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rename, reorder or activate a topic' })
  @ApiOkResponse({ description: 'The updated topic' })
  @ApiForbiddenResponse({ description: "The subject's exam belongs to another editor" })
  async updateTopic(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: RequestLike,
  ): Promise<TopicNode> {
    return this.catalog.updateTopic(actor, parseUuid(id, 'topic id'), body, requestMeta(request));
  }

  @RequirePermissions('content.write')
  @Delete('topics/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a topic' })
  @ApiForbiddenResponse({ description: "The subject's exam belongs to another editor" })
  async deleteTopic(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Req() request: RequestLike,
  ): Promise<void> {
    await this.catalog.deleteTopic(actor, parseUuid(id, 'topic id'), requestMeta(request));
  }
}
