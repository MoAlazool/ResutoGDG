import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

/** search module (21-SHELL): record search for the staff command palette over orders, customers and the menu. */
@Module({
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
