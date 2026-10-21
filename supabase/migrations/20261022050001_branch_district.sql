-- Branch district (gallery PAR-02). The legacy Smash & Co storefront labelled delivery with the branch's
-- neighbourhood ("Downtown"); the 2.0 storefront fell back to the city in Latin script, even on Arabic pages.
-- A branch now carries its district in English and Arabic, shown on the storefront and editable with the branch.
-- Additive and nullable: existing branches keep working unchanged. Reversible:
--   alter table branches drop column district, drop column district_ar;
alter table branches
  add column if not exists district text,
  add column if not exists district_ar text;

alter table branches
  add constraint branches_district_check check (district is null or length(btrim(district)) between 1 and 80),
  add constraint branches_district_ar_check check (district_ar is null or length(btrim(district_ar)) between 1 and 80);

comment on column branches.district is 'Neighbourhood shown to guests (storefront delivery label), English';
comment on column branches.district_ar is 'Neighbourhood shown to guests on Arabic pages';
