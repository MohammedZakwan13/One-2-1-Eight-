import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { ZodTypeAny } from 'zod';
import { adminProductInputSchema, adminProductSchema, availabilitySchema, productSchema } from '../../lib/api/schemas';
import { STOCK_MESSAGE_MODES } from '../../lib/inventory';

type Schema = { required?: string[]; properties?: Record<string, { enum?: string[]; maximum?: number; minimum?: number; description?: string }>; allOf?: Schema[]; description?: string };
type Doc = { paths: Record<string, Record<string, { responses: Record<string, { description?: string }> }>>; components: { schemas: Record<string, Schema>; responses: Record<string, { description: string }> } };
const doc = parse(fs.readFileSync(path.join(__dirname, '../../openapi/openapi.yaml'), 'utf8')) as Doc;
const schemas = doc.components.schemas;

/** Unwraps refine()/superRefine() effects down to the object schema. */
const objectOf = (schema: ZodTypeAny): ZodTypeAny & { shape: Record<string, ZodTypeAny> } => {
  let current = schema as unknown as { _def: { schema?: ZodTypeAny }; shape?: Record<string, ZodTypeAny> };
  while (!current.shape && current._def.schema) current = current._def.schema as unknown as typeof current;
  return current as never;
};
const keys = (schema: ZodTypeAny) => Object.keys(objectOf(schema).shape).sort();
const requiredKeys = (schema: ZodTypeAny) => Object.entries(objectOf(schema).shape).filter(([, value]) => !value.isOptional()).map(([key]) => key).sort();

describe('OpenAPI ⇄ Zod: product input (stock intent, modes, custom number)', () => {
  const input = schemas.AdminProductInput;
  it('documents exactly the fields the API accepts', () => expect(Object.keys(input.properties ?? {}).sort()).toEqual(keys(adminProductInputSchema)));
  it('requires exactly the fields the API requires: `variants` is optional (metadata-only saves)', () => {
    expect([...(input.required ?? [])].sort()).toEqual(requiredKeys(adminProductInputSchema));
    expect(input.required).not.toContain('variants');
  });
  it('documents the stock snapshot, the modes and the custom-number rules', () => {
    expect(input.properties?.expectedStock).toBeDefined();
    expect(input.properties?.expectedStock.description).toMatch(/stock_conflict/);
    expect(input.properties?.variants.description).toMatch(/expectedStock/);
    expect(input.properties?.stockMessageMode.enum).toEqual([...STOCK_MESSAGE_MODES]);
    expect(input.properties?.stockMessageNumber.description).toMatch(/only with `stockMessageMode: custom`/i);
    expect(input.properties?.stockMessageNumber.minimum).toBe(0);
    expect(input.properties?.stockMessageNumber.maximum).toBe(100000);
  });
  it('the documented number range is the enforced range', () => {
    const accepts = (value: number) => objectOf(adminProductInputSchema).shape.stockMessageNumber.safeParse(value).success;
    expect([accepts(0), accepts(100000), accepts(100001), accepts(-1)]).toEqual([true, true, false, false]);
  });
});

describe('OpenAPI ⇄ Zod: public product, availability and admin product', () => {
  it('Product documents every field the API returns (incl. stockMessageMode / stockMessageNumber)', () => {
    expect(Object.keys(schemas.Product.properties ?? {}).sort()).toEqual(keys(productSchema));
    expect(schemas.Product.properties?.stockMessageMode.enum).toEqual([...STOCK_MESSAGE_MODES]);
  });
  it('Availability documents the Real-mode-only quantity', () => {
    expect(Object.keys(schemas.Availability.properties ?? {}).sort()).toEqual(keys(availabilitySchema));
    expect(schemas.Availability.properties?.quantity.description).toMatch(/ONLY on products whose `stockMessageMode` is `real`/);
    expect(schemas.Availability.required).toEqual(['status']);
  });
  it('AdminProduct documents the review flag', () => {
    const documented = (schemas.AdminProduct.allOf ?? []).flatMap(part => Object.keys(part.properties ?? {}));
    expect(documented).toContain('stockMessageReview');
    const extra = keys(adminProductSchema).filter(key => !keys(productSchema).includes(key));
    for (const key of extra) expect(documented).toContain(key);
  });
});

describe('OpenAPI: error responses and cart exposure', () => {
  const put = doc.paths['/admin/products/{id}'].put.responses;
  const post = doc.paths['/admin/products'].post.responses;
  it('documents the stock conflict (409) and validation (422) on product update', () => {
    expect(put['409'].description).toMatch(/stock_conflict/);
    expect(put['409'].description).toMatch(/Nothing was saved/);
    expect(put['409'].description).toMatch(/stock_snapshot_required/);
    expect(put['422'].description).toMatch(/expectedStock/);
  });
  it('documents the migration-required (503) response on create and update', () => {
    expect(put['503'].description).toMatch(/migration_required/);
    expect(post['503'].description).toMatch(/migration_required/);
    expect(post['422'].description).toMatch(/variants/);
  });
  it('lists the new machine-readable error codes', () => {
    for (const code of ['stock_conflict', 'stock_snapshot_required', 'migration_required']) expect(doc.components.responses.Error.description).toContain(code);
  });
  it('states that the cart reveals stock only for Real Stock products', () => {
    const line = schemas.CartLine.properties as unknown as Record<string, { description?: string }>;
    expect(line.maxQuantity.description).toMatch(/Real Stock mode/);
    expect(line.maxQuantity.description).toMatch(/never reveals stock/);
  });
});
