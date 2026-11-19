/* eslint-disable @typescript-eslint/no-explicit-any -- an in-memory stand-in for the slice of Supabase the Luxe band routes use */
type Row = Record<string, any>;
type Result = { data: any; error: { code?: string; message: string } | null; count?: number };

/**
 * In-memory stand-in for the parts of Supabase used by the homepage Luxe band routes: the single `store_settings` row (with or without the
 * migration-0011 column), the tables the "is this picture still used?" checks read (`products`, `categories`, `hero_slides`) and Storage.
 */
export function createFakeLuxeDb(options: { migrated: boolean; luxe?: Row | null; products?: Row[]; categories?: Row[]; slides?: Row[]; storedFiles?: string[]; failSettingsUpdate?: boolean } = { migrated: true }) {
  const settings: Row = {
    id: 1, brand_name: 'ONE 2 1 EIGHT', brand_line: '', promo_text: '', announcement_enabled: true, free_shipping_threshold: 1499, shipping_fee: 79, low_stock_threshold: 5,
    return_policy: '', seo_title: 't', seo_description: 'd', contact_email: 'a@b.co', contact_phone: '1', updated_at: '2026-01-01T00:00:00.000Z',
    ...(options.migrated ? { luxe_feature: options.luxe ?? null } : {}),
  };
  const tables: Record<string, Row[]> = { store_settings: [settings], products: options.products ?? [], categories: options.categories ?? [], hero_slides: options.slides ?? [] };
  const files = new Map<string, { created_at: string }>((options.storedFiles ?? []).map(path => [path, { created_at: '2026-01-01T00:00:00.000Z' }]));
  const removed: string[] = [];
  const writes: { table: string; payload: Row }[] = [];

  class Query implements PromiseLike<Result> {
    private columns = '*'; private head = false; private wantCount = false; private filters: ((row: Row) => boolean)[] = []; private mode: 'many' | 'single' | 'maybe' = 'many';
    private op: 'select' | 'update' = 'select'; private payload: Row = {};
    constructor(private table: string) {}
    select(columns = '*', opts?: { count?: string; head?: boolean }) { this.columns = columns; this.head = !!opts?.head; this.wantCount = !!opts?.count; return this; }
    update(payload: Row) { this.op = 'update'; this.payload = payload; return this; }
    eq(column: string, value: unknown) { this.filters.push(row => row[column] === value); return this; }
    contains(column: string, values: unknown[]) { this.filters.push(row => Array.isArray(row[column]) && values.every(value => row[column].includes(value))); return this; }
    or(expression: string) { const pairs = expression.split(',').map(part => part.split('.eq.')); this.filters.push(row => pairs.some(([column, value]) => row[column] === value)); return this; }
    order() { return this; }
    limit() { return this; }
    single() { this.mode = 'single'; return this; }
    maybeSingle() { this.mode = 'maybe'; return this; }
    private run(): Result {
      const rows = tables[this.table].filter(row => this.filters.every(filter => filter(row)));
      if (this.op === 'update') {
        if (this.table === 'store_settings') {
          if (options.failSettingsUpdate) return { data: null, error: { code: 'XX000', message: 'connection reset' } };
          for (const key of Object.keys(this.payload)) if (!(key in settings)) return { data: null, error: { code: 'PGRST204', message: `Could not find the '${key}' column of 'store_settings' in the schema cache` } };
        }
        writes.push({ table: this.table, payload: this.payload });
        for (const row of rows) Object.assign(row, this.payload);
        return this.finish(rows);
      }
      if (this.table === 'store_settings' && this.columns !== '*') {
        for (const column of this.columns.split(',').map(part => part.trim())) if (!(column in settings)) return { data: null, error: { code: '42703', message: `column store_settings.${column} does not exist` } };
      }
      if (this.head) return { data: null, error: null, count: rows.length };
      return this.finish(rows);
    }
    private finish(rows: Row[]): Result {
      const count = this.wantCount ? rows.length : undefined;
      if (this.mode === 'single') return rows.length === 1 ? { data: rows[0], error: null, count } : { data: null, error: { code: 'PGRST116', message: 'no rows' } };
      if (this.mode === 'maybe') return { data: rows[0] ?? null, error: null, count };
      return { data: rows, error: null, count };
    }
    then<A = Result, B = never>(onfulfilled?: ((value: Result) => A | PromiseLike<A>) | null, onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null) {
      return Promise.resolve().then(() => this.run()).then(onfulfilled, onrejected);
    }
  }

  const client = {
    from: (table: string) => new Query(table),
    rpc: async () => ({ data: null, error: null }),
    storage: {
      from: (_bucket: string) => ({
        remove: async (paths: string[]) => { for (const path of paths) { removed.push(path); files.delete(path); } return { error: null }; },
        list: async (prefix: string) => {
          const depth = prefix.split('/').length;
          const names = new Map<string, boolean>();
          for (const path of files.keys()) {
            if (!path.startsWith(`${prefix}/`)) continue;
            const parts = path.split('/');
            names.set(parts[depth], parts.length === depth + 1);
          }
          return { data: [...names].map(([name, isFile]) => (isFile ? { name, id: `id-${name}`, created_at: files.get(`${prefix}/${name}`)!.created_at } : { name, id: null })), error: null };
        },
        upload: async (path: string) => { files.set(path, { created_at: new Date().toISOString() }); return { error: null }; },
      }),
    },
  };
  return Object.assign(client, { settings, tables, files, removed, writes });
}

export type FakeLuxeDb = ReturnType<typeof createFakeLuxeDb>;
