import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module';
import { StudioAiService } from './ai/studio-ai.service';
import { BrandController } from './brand.controller';
import { BrandService } from './brand.service';
import { MenuExtractionService } from './menu-extraction/menu-extraction.service';
import { StudioAiController } from './studio-ai.controller';
import { PHOTO_GENERATIVE_PROVIDERS } from './photos/generative';
import { StudioPhotosService } from './photos/photos.service';
import { CreativeService } from './creative.service';
import { DNS_RESOLVER, DOMAIN_PROVIDER, domainProviderFromEnv, systemTxtResolver } from './domain-provider';
import { DomainsService } from './domains.service';
import { PublicSitesController } from './public-sites.controller';
import { PublicSitesService } from './public-sites.service';
import { SiteBuilderService } from './site-builder.service';
import { StorefrontsService } from './storefronts.service';
import { StudioController } from './studio.controller';
import { StudioService } from './studio.service';

/**
 * ResutoStudio (owner: Agent F): restaurant website editor with publish
 * revisions, media library, custom domains and AI creative; public website API.
 * DNS_RESOLVER and DOMAIN_PROVIDER are injection tokens so tests and
 * deployments can swap the resolver and hosting provider.
 */
@Module({
  // IntegrationsModule: the restaurant's own model key (gemini_byok connection) for Studio AI.
  imports: [IntegrationsModule],
  controllers: [StudioController, PublicSitesController, StudioAiController, BrandController],
  providers: [
    StudioAiService, MenuExtractionService, StudioPhotosService,
    // Generative photo providers: none configured (BYOK only, FT-04); see photos/generative.ts.
    { provide: PHOTO_GENERATIVE_PROVIDERS, useValue: [] },
    StudioService, BrandService, SiteBuilderService, DomainsService, CreativeService, PublicSitesService, StorefrontsService,
    { provide: DNS_RESOLVER, useValue: systemTxtResolver },
    { provide: DOMAIN_PROVIDER, useFactory: () => domainProviderFromEnv() },
  ],
  // StudioService: change sets edit drafts and publish in their own transaction (21-CS).
  exports: [PublicSitesService, StudioService],
})
export class StudioModule {}
