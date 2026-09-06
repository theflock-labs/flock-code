/** Structural subset of Vercel's Node handler API; no runtime SDK is needed. */
export interface VercelRequest { method?: string; body?: any; }
export interface VercelResponse {
  status(code: number): VercelResponse;
  json(body: unknown): unknown;
  end(): unknown;
  setHeader(name: string, value: string): unknown;
}
