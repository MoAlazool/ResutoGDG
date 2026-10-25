import { Module } from '@nestjs/common';
import { ChangesModule } from '../changes/changes.module';
import { StudioEditingService } from './ai/studio-editing.service';
import { StudioEditingController } from './studio-editing.controller';

/**
 * Studio AI editing through change sets (21-STUDIO). A module of its own because the change-set engine already
 * depends on StudioModule (its website ops edit drafts): this one depends on both without a cycle.
 */
@Module({
  imports: [ChangesModule],
  controllers: [StudioEditingController],
  providers: [StudioEditingService],
})
export class StudioEditingModule {}
