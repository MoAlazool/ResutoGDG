import { Module } from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import { PlatformController } from './platform.controller';

@Module({ controllers: [PlatformController], providers: [OrganizationsService], exports: [OrganizationsService] })
export class PlatformModule {}
