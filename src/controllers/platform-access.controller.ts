import { Controller, Get, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../guards/auth.guard';
import { PlatformAccessService } from '../services/platform-access.service';

interface AuthReq extends Request {
  user: { id: string; email: string };
}

@ApiTags('platform-admin')
@Controller('platform-admin')
@UseGuards(AuthGuard)
@ApiBearerAuth()
export class PlatformAccessController {
  constructor(private readonly platformAccess: PlatformAccessService) {}

  @Get('access')
  @ApiOperation({
    summary: 'Current user platform roles (super-admin vs staff)',
  })
  async access(@Request() req: AuthReq) {
    const superAdmin = this.platformAccess.isSuperAdmin(req.user);
    const staff = await this.platformAccess.hasStaffAccess(req.user);
    return { superAdmin, staff };
  }
}
