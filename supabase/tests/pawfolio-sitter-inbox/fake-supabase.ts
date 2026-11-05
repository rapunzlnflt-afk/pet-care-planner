// Test double for supabase-js: translates the small query-builder subset used
// by the function into SQL against PGlite (real Postgres, with migration 0009).
import { PGlite } from "npm:@electric-sql/pglite";
export const db = new PGlite();
await db.exec("create role anon; create role authenticated;");
await db.exec(await Deno.readTextFile(Deno.env.get("MIGRATION")!));
(globalThis as any).__db = db;

class Q {
  t: string; op = "select"; cols = "*"; wh: [string, string, unknown][] = []; ord: string[] = [];
  lim?: number; one: "" | "maybe" | "single" = ""; row: any; ret = false; count = false; head = false;
  constructor(t: string) { this.t = t; }
  select(c = "*", o?: any) { if (this.op === "select") this.cols = c; else { this.ret = true; this.cols = c; }
    if (o?.count) this.count = true; if (o?.head) this.head = true; return this; }
  insert(r: any) { this.op = "insert"; this.row = r; return this; }
  update(r: any) { this.op = "update"; this.row = r; return this; }
  delete() { this.op = "delete"; return this; }
  eq(c: string, v: unknown) { this.wh.push([c, "=", v]); return this; }
  neq(c: string, v: unknown) { this.wh.push([c, "<>", v]); return this; }
  lt(c: string, v: unknown) { this.wh.push([c, "<", v]); return this; }
  in(c: string, v: unknown[]) { this.wh.push([c, "in", v]); return this; }
  order(c: string, o?: any) { this.ord.push(`${c} ${o?.ascending === false ? "desc" : "asc"}`); return this; }
  limit(n: number) { this.lim = n; return this; }
  maybeSingle() { this.one = "maybe"; return this; }
  single() { this.one = "single"; return this; }
  async run() {
    const p: unknown[] = []; const ph = (v: unknown) => { p.push(v); return `$${p.length}`; };
    const where = this.wh.length ? " where " + this.wh.map(([c, o, v]) =>
      o === "in" ? `${c} = any(${ph(v)})` : `${c} ${o} ${ph(v)}`).join(" and ") : "";
    let sql: string;
    const cols = this.cols.split(",").map((s) => s.trim()).join(", ");
    if (this.op === "select") {
      sql = `select ${this.count ? "count(*)::int as n" : cols} from ${this.t}${where}` +
        (this.ord.length && !this.count ? " order by " + this.ord.join(", ") : "") + (this.lim ? ` limit ${this.lim}` : "");
    } else if (this.op === "insert") {
      const ks = Object.keys(this.row);
      sql = `insert into ${this.t} (${ks.join(", ")}) values (${ks.map((k) => ph(typeof this.row[k] === "object" && this.row[k] ? JSON.stringify(this.row[k]) : this.row[k])).join(", ")})` + (this.ret ? ` returning ${cols}` : "");
    } else if (this.op === "update") {
      const ks = Object.keys(this.row).filter((k) => this.row[k] !== undefined);
      sql = `update ${this.t} set ${ks.map((k) => `${k} = ${ph(this.row[k])}`).join(", ")}${where}` + (this.ret ? ` returning ${cols}` : "");
    } else {
      sql = `delete from ${this.t}${where}` + (this.ret ? ` returning ${cols}` : "");
    }
    try {
      const r = await db.query<any>(sql, p);
      let rows = r.rows.map((x: any) => { for (const k in x) if (x[k] instanceof Date) x[k] = x[k].toISOString(); return x; });
      if (this.count) return { data: this.head ? null : rows, count: rows[0].n, error: null };
      if (this.one) {
        if (rows.length > 1 || (this.one === "single" && !rows.length)) return { data: null, error: { code: "PGRST116", message: "rows" } };
        return { data: rows[0] ?? null, error: null };
      }
      return { data: rows, error: null };
    } catch (e: any) {
      return { data: null, error: { code: e.code, message: e.message, details: e.detail } };
    }
  }
  then(a: any, b: any) { return this.run().then(a, b); }
}
export function createClient(..._a: unknown[]) { return { from: (t: string) => new Q(t) }; }
