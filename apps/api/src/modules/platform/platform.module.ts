import { Module } from '@nestjs/common';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';
import { OrganizationsService } from './organizations.service';
import { PlatformController } from './platform.controller';
import { SetupController } from './setup.controller';
import { SetupService } from './setup.service';

@Module({
  controllers: [PlatformController, SetupController, OnboardingController],
  providers: [OrganizationsService, SetupService, OnboardingService],
  exports: [OrganizationsService, SetupService],
})
export class PlatformModule {}
