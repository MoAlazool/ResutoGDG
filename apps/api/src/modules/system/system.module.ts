import { Module } from '@nestjs/common';
import { HealthDetailsService } from './health-details.service';
import { MaintenanceJobs } from './maintenance.jobs';
import { SystemController } from './system.controller';

@Module({ controllers: [SystemController], providers: [MaintenanceJobs, HealthDetailsService] })
export class SystemModule {}
