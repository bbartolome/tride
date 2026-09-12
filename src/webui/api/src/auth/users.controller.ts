import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ERROR_CODES } from '../common/error-codes';
import { AdminGuard } from './admin.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import type { Identity } from './identity.middleware';
import { UsersService } from './users.service';
import {
  isValidLogin,
  isValidRole,
  normalizeLoginForStorage,
  type UserListEntry,
  type UserRole,
} from './users.types';

function validationError(message: string): BadRequestException {
  return new BadRequestException({
    code: ERROR_CODES.VALIDATION_ERROR,
    message,
  });
}

interface MeResponse {
  login: string;
  name?: string;
  picture?: string;
  role?: 'admin' | 'user';
  seeded?: boolean;
}

function parseCreateBody(body: unknown): { login: string; role: UserRole } {
  const record = (
    typeof body === 'object' && body !== null ? body : {}
  ) as Record<string, unknown>;
  if (!isValidLogin(record.login)) {
    throw validationError(
      'login must match /^[^\\s,@]{1,64}@[^\\s,@]{1,189}$/',
    );
  }
  if (!isValidRole(record.role)) {
    throw validationError("role must be 'admin' or 'user'");
  }
  return { login: normalizeLoginForStorage(record.login), role: record.role };
}

function parseRoleBody(body: unknown): UserRole {
  const record = (
    typeof body === 'object' && body !== null ? body : {}
  ) as Record<string, unknown>;
  if (!isValidRole(record.role)) {
    throw validationError("role must be 'admin' or 'user'");
  }
  return record.role;
}

function parseLoginParam(rawLogin: string): string {
  if (!isValidLogin(rawLogin)) {
    throw validationError('login path segment is malformed');
  }
  return normalizeLoginForStorage(rawLogin);
}

@Controller('api')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  me(@CurrentUser() identity: Identity | null): MeResponse {
    // This route is not @Public(), so TailscaleAuthGuard already ran and
    // guarantees a non-null identity with role/seeded populated from
    // UsersService.isAllowed() by the time we get here.
    if (identity === null) {
      throw validationError('missing identity');
    }
    return {
      login: identity.login,
      name: identity.name,
      picture: identity.profilePicUrl,
      role: identity.role,
      seeded: identity.seeded,
    };
  }

  @UseGuards(AdminGuard)
  @Get('users')
  listUsers(): Promise<UserListEntry[]> {
    return this.usersService.list();
  }

  @UseGuards(AdminGuard)
  @Post('users')
  addUser(@Body() body: unknown, @CurrentUser() identity: Identity | null) {
    const { login, role } = parseCreateBody(body);
    const addedBy = identity?.login ?? 'unknown';
    return this.usersService.add(login, role, addedBy);
  }

  @UseGuards(AdminGuard)
  @Patch('users/:login')
  updateUser(@Param('login') rawLogin: string, @Body() body: unknown) {
    const login = parseLoginParam(rawLogin);
    const role = parseRoleBody(body);
    return this.usersService.update(login, role);
  }

  @UseGuards(AdminGuard)
  @Delete('users/:login')
  async removeUser(
    @Param('login') rawLogin: string,
    @CurrentUser() identity: Identity | null,
  ): Promise<{ ok: true }> {
    const login = parseLoginParam(rawLogin);

    // Seeded-immutability is checked before the self-removal check: deleting
    // a seeded login must always come back 409 SEEDED_IMMUTABLE, even when
    // that seeded login happens to be the caller's own — this ordering
    // avoids a seeded admin's DELETE-self ever reading as "just" a lockout
    // guard instead of the immutability rule it actually is.
    if (this.usersService.isSeededLogin(login)) {
      throw new ConflictException({
        code: ERROR_CODES.SEEDED_IMMUTABLE,
        message: 'Login is a seeded admin and cannot be removed',
      });
    }
    if (identity !== null && identity.login === login) {
      throw validationError('Cannot remove your own account');
    }
    await this.usersService.remove(login);
    return { ok: true };
  }
}
