import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { OPENAPI_V1_SPEC } from '../../api-v1/openapi.spec';

/**
 * Serves the Public API v1 OpenAPI document. Unauthenticated on purpose so SDK
 * generators and integrators can fetch the contract before they have a key.
 */
@ApiTags('public-api-v1')
@Controller('api/v1')
export class OpenApiV1Controller {
  @Get('openapi.json')
  @ApiOperation({ summary: 'OpenAPI 3.1 spec for the Public API v1' })
  getSpec() {
    return OPENAPI_V1_SPEC;
  }
}
