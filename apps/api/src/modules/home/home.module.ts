import { Module } from '@nestjs/common';
import { AttentionService } from './attention.service';
import { HomeController } from './home.controller';
import { PreferencesService } from './preferences.service';

/** home module (21-HOME): the overview's attention aggregator and per-user preferences. */
@Module({
  controllers: [HomeController],
  providers: [AttentionService, PreferencesService],
})
export class HomeModule {}
