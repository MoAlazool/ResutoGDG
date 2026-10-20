import { Module } from '@nestjs/common';
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
  controllers: [StudioController, PublicSitesController],
  providers: [
    StudioService, SiteBuilderService, DomainsService, CreativeService, PublicSitesService, StorefrontsService,
    { provide: DNS_RESOLVER, useValue: systemTxtResolver },
    { provide: DOMAIN_PROVIDER, useFactory: () => domainProviderFromEnv() },
  ],
  exports: [PublicSitesService],
})
export class StudioModule {}
