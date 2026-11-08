import { randomUUID } from 'node:crypto';

/**
 * In-memory stand-in for the slice of Supabase the hero banner routes use: tables `hero_slides` (+ small fixed `store_settings` /
 * `categories` for the storefront route), `rpc('reorder_hero_slides')` and Storage (`media` / `banner-media`). The reorder semantics
 * deliberately mirror supabase/migrations/0010_hero_banner_media.sql. `migrated: false` simulates a database without that migration:
 * the new columns do not exist (rows have only the original ones) and writing them or calling the function fails.
 */
export type HeroRow = Record<string, unknown> & { id: string };
type Result = { data: unknown; error: { code?: string; message: string } | null };

const ORIGINAL = ['id', 'kicker', 'title', 'body', 'desktop_image', 'mobile_image', 'cta', 'href', 'active', 'sort_order'];

export function createFakeHeroDb(options: { migrated?: boolean } = {}) {
  const migrated = options.migrated ?? true;
  const slides: HeroRow[] = [];
  const storage = { media: new Map<string, { created_at: string }>(), 'banner-media': new Map<string, { created_at: string }>() } as Record<string, Map<string, { created_at: string }>>;
  const removed: { bucket: string; paths: string[] }[] = [];
  let tick = 0;
  const stamp = () => new Date(Date.UTC(2026, 10, 8, 0, 0, 0) + (tick += 1) * 1000).toISOString();

  /** Adds a banner as it would exist before / after the migration. */
  const seed = (row: Partial<HeroRow> & { title: string }): HeroRow => {
    const base: HeroRow = {
      id: randomUUID(), kicker: '', body: '', desktop_image: '/images/d.webp', mobile_image: '/images/m.webp', cta: '', href: '/collections/all', active: true, sort_order: slides.length + 1,
      ...(migrated ? { desktop_media_type: 'image', desktop_video: '', mobile_media_type: 'image', mobile_video: '', use_desktop_on_mobile: false, alt_text: '', created_at: stamp(), updated_at: stamp() } : {}),
      ...row,
    };
    slides.push(base);
    return base;
  };

  const sorted = () => [...slides].sort((a, b) => Number(a.sort_order) - Number(b.sort_order) || String(a.id).localeCompare(String(b.id)));
  const schemaError = (patch: Record<string, unknown>) => (!migrated && Object.keys(patch).some(key => !ORIGINAL.includes(key)) ? { code: '42703', message: 'column "desktop_media_type" of relation "hero_slides" does not exist' } : null);

  class Query implements PromiseLike<Result> {
    private op: 'select' | 'insert' | 'update' | 'delete' = 'select';
    private filters: [string, unknown][] = [];
    private orders: [string, boolean][] = [];
    private max = Infinity;
    private payload: Record<string, unknown> = {};
    private columns = '*';
    private wantCount = false;
    private orFilter = '';
    private mode: 'many' | 'single' | 'maybe' = 'many';
    constructor(private table: string) {}
    select(columns = '*', opts?: { count?: string; head?: boolean }) { this.columns = columns; this.wantCount = Boolean(opts?.count); return this; }
    contains() { return this; }
    or(expression: string) { this.orFilter = expression; return this; }
    insert(row: Record<string, unknown>) { this.op = 'insert'; this.payload = row; return this; }
    update(patch: Record<string, unknown>) { this.op = 'update'; this.payload = patch; return this; }
    delete() { this.op = 'delete'; return this; }
    eq(column: string, value: unknown) { this.filters.push([column, value]); return this; }
    order(column: string, opts: { ascending?: boolean } = {}) { this.orders.push([column, opts.ascending !== false]); return this; }
    limit(count: number) { this.max = count; return this; }
    single() { this.mode = 'single'; return this; }
    maybeSingle() { this.mode = 'maybe'; return this; }
    then<A, B>(onfulfilled?: ((value: Result) => A | PromiseLike<A>) | null, onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null) { return Promise.resolve(this.run()).then(onfulfilled, onrejected); }

    private project(rows: HeroRow[]) {
      const cols = this.columns === '*' ? null : this.columns.split(',').map(col => col.trim());
      return rows.map(row => (cols ? Object.fromEntries(cols.map(col => [col, row[col]])) : { ...row }));
    }
    private finish(rows: HeroRow[]): Result {
      const data = this.project(rows).slice(0, this.max);
      if (this.mode === 'many') return this.wantCount ? ({ data, error: null, count: rows.length } as Result) : { data, error: null };
      if (data.length === 0) return this.mode === 'single' ? { data: null, error: { code: 'PGRST116', message: 'no rows' } } : { data: null, error: null };
      return { data: data[0], error: null };
    }
    private run(): Result {
      if (this.table === 'store_settings') return { data: { id: 1, brand_name: 'ONE 2 1 EIGHT', brand_line: '', promo_text: '', announcement_enabled: true, free_shipping_threshold: 1499, shipping_fee: 79, low_stock_threshold: 5, return_policy: '', seo_title: 't', seo_description: 'd', contact_email: 'a@b.co', contact_phone: '1' }, error: null };
      if (this.table === 'categories') return { data: [], error: null, count: 0 } as Result;
      if (this.table !== 'hero_slides') return { data: [], error: null, count: 0 } as Result;
      const matches = (row: HeroRow) => this.filters.every(([column, value]) => row[column] === value);
      if (this.op === 'insert') {
        const failure = schemaError(this.payload);
        if (failure) return { data: null, error: failure };
        const row = seed({ title: '', ...this.payload } as HeroRow & { title: string });
        return this.finish([row]);
      }
      if (this.op === 'update') {
        const failure = schemaError(this.payload);
        if (failure) return { data: null, error: failure };
        const hit = slides.filter(matches);
        for (const row of hit) Object.assign(row, this.payload);
        return this.finish(hit);
      }
      if (this.op === 'delete') {
        const hit = slides.filter(matches);
        for (const row of hit) slides.splice(slides.indexOf(row), 1);
        return { data: null, error: null };
      }
      let rows = sorted().filter(matches);
      if (this.orFilter) { const pairs = this.orFilter.split(',').map(part => part.split('.eq.')); rows = rows.filter(row => pairs.some(([column, value]) => row[column] === value)); }
      for (const [column, ascending] of [...this.orders].reverse()) if (column !== 'sort_order' && column !== 'id') rows = [...rows].sort((a, b) => (ascending ? 1 : -1) * (Number(a[column]) - Number(b[column])));
      const first = this.orders[0];
      if (first && first[0] === 'sort_order' && !first[1]) rows = [...rows].reverse();
      return this.finish(rows);
    }
  }

  const client = {
    slides, storage, removed, seed,
    /** Set to make every Storage upload fail the way supabase-js reports it (message, name, status / statusCode). */
    uploadFailure: null as null | { message: string; name?: string; status?: number; statusCode?: string },
    from: (table: string) => new Query(table),
    rpc: async (name: string, args: { p_ids: string[] }): Promise<Result> => {
      if (name !== 'reorder_hero_slides' || !migrated) return { data: null, error: { code: '42883', message: 'function public.reorder_hero_slides(uuid[]) does not exist' } };
      const ids = args.p_ids;
      const known = slides.map(slide => slide.id);
      if (ids.length !== known.length || new Set(ids).size !== ids.length || known.some(id => !ids.includes(id))) return { data: null, error: { code: 'P0001', message: 'order_stale' } };
      ids.forEach((id, index) => { slides.find(slide => slide.id === id)!.sort_order = index + 1; });
      return { data: ids.length, error: null };
    },
    storageApi: {
      from: (bucket: string) => ({
        upload: async (path: string) => {
          if (client.uploadFailure) return { error: client.uploadFailure };
          if (!migrated && bucket === 'banner-media') return { error: { message: 'Bucket not found' } };
          storage[bucket].set(path, { created_at: stamp() });
          return { error: null };
        },
        remove: async (paths: string[]) => { removed.push({ bucket, paths }); for (const path of paths) storage[bucket].delete(path); return { error: null }; },
        list: async () => ({ data: [], error: null }),
      }),
    },
  };
  return Object.assign(client, { storage: Object.assign(storage, { from: client.storageApi.from }) });
}

export type FakeHeroDb = ReturnType<typeof createFakeHeroDb>;
