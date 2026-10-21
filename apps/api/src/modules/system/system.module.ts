import { Module } from '@nestjs/common';
import { OpenApiService } from '../../common/http/openapi';
import { HealthDetailsService } from './health-details.service';
import { MaintenanceJobs } from './maintenance.jobs';
import { SystemController } from './system.controller';

@Module({ controllers: [SystemController], providers: [MaintenanceJobs, HealthDetailsService, OpenApiService] })
export class SystemModule {}
