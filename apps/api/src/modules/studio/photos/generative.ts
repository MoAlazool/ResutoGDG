/**
 * Pluggable generative image-edit providers for Studio photos (FT-04). NONE is configured: Resuto does not fund model
 * calls, and generative edits can change what a dish looks like (invented garnish, portion, ingredients). A provider
 * may only be registered for the restaurant's own key (BYOK) and every result it produces goes through the same human
 * review as deterministic edits, labelled `mode: generative` with the provider and model in its provenance.
 *
 * To add one: implement this interface (calling the provider with the restaurant's own credentials, outside any
 * database transaction), and provide it under PHOTO_GENERATIVE_PROVIDERS in StudioModule. Until then the API refuses
 * `mode: generative` with 409 generative_not_configured and the dashboard shows the option as not configured.
 */
export interface PhotoGenerativeProvider {
  /** Stable id stored as the job's provider, e.g. "gemini_byok_image". */
  readonly id: string;
  /** Shown to the reviewer next to the result. */
  readonly label: string;
  /** Whether this tenant has the provider configured with its own key. */
  configured(orgId: string): Promise<boolean>;
  /**
   * Edits the photo. Must preserve the dish (no added or removed food, no portion change); the prompt it uses is part
   * of the returned provenance so the reviewer can see what was asked.
   */
  edit(orgId: string, input: { bytes: Buffer; mime: string }): Promise<{ bytes: Buffer; mime: 'image/jpeg' | 'image/png' | 'image/webp'; model: string; prompt: string }>;
}

export const PHOTO_GENERATIVE_PROVIDERS = Symbol.for('resuto.studio.photoGenerativeProviders');
