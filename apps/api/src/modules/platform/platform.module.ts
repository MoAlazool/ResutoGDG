import { Module } from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import { PlatformController } from './platform.controller';
import { SetupController } from './setup.controller';
import { SetupService } from './setup.service';

@Module({ controllers: [PlatformController, SetupController], providers: [OrganizationsService, SetupService], exports: [OrganizationsService, SetupService] })
export class PlatformModule {}
