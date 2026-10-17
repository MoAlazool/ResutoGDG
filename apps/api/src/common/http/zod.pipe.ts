import { PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/** Validates and normalises a request part with a shared contract schema. */
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}
  transform(value: unknown): T {
    return this.schema.parse(value);
  }
}
export const zod = <T>(schema: ZodType<T>) => new ZodPipe(schema);
