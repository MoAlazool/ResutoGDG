import type { PhoneCountry } from '@resuto/contracts';
import type { Tx } from '../../common/db/db.service';

/** The restaurant's country for local phone formats (CR-06): Saudi Arabia when set to SA, otherwise Egypt. */
export const orgCountry = async (tx: Tx, orgId: string): Promise<PhoneCountry> =>
  phoneCountry((await tx.one<{ country: string | null }>('select country from organizations where id = $1', [orgId])).country);

/** The local phone format of an organisation country column value. */
export const phoneCountry = (country: string | null | undefined): PhoneCountry => (country === 'SA' ? 'SA' : 'EG');
