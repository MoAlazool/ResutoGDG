import { Module } from '@nestjs/common';
import { MaintenanceJobs } from './maintenance.jobs';
import { SystemController } from './system.controller';

@Module({ controllers: [SystemController], providers: [MaintenanceJobs] })
export class SystemModule {}
