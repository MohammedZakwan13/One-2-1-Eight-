import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import nextConfig from '../../next.config';

describe('Vercel deployment configuration', () => {
  it('traces openapi/openapi.yaml into the function that reads it at request time', () => {
    expect(nextConfig.outputFileTracingIncludes).toEqual({ '/api/v1/openapi.json': ['./openapi/openapi.yaml'] });
    expect(existsSync('openapi/openapi.yaml')).toBe(true);
    const route = readFileSync('app/api/v1/openapi.json/route.ts', 'utf8');
    expect(route).toContain("path.join(process.cwd(), 'openapi', 'openapi.yaml')");
  });
  it('traces one file for one route, not the repository', () => {
    const includes = nextConfig.outputFileTracingIncludes ?? {};
    expect(Object.keys(includes)).toEqual(['/api/v1/openapi.json']);
    for (const files of Object.values(includes)) for (const file of files) expect(file).toMatch(/\.yaml$/);
  });
  it('vercel.json keeps the framework preset and a valid duration for the API function', () => {
    const config = JSON.parse(readFileSync('vercel.json', 'utf8')) as { framework: string; functions: Record<string, { maxDuration: number }> };
    expect(config.framework).toBe('nextjs');
    expect(config.functions['app/api/v1/[...path]/route.ts'].maxDuration).toBeLessThanOrEqual(60);
  });
});
