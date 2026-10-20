import { GuestLoading } from '@/components/guest/GuestLoading';

/** Branded loading shell while the server reads the restaurant (VP-10). */
export default function Loading() {
  return <GuestLoading variant="booking" />;
}
