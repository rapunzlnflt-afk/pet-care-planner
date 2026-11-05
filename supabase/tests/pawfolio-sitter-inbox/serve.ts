// Runs the real function with the fake client. Test hook: POST /__sql {sql}.
const origServe = Deno.serve;
(Deno as any).serve = (h: any) => origServe({ port: Number(Deno.env.get("PORT") ?? 8788), hostname: "127.0.0.1", onListen: () => console.log("fn up") },
  async (req: Request) => {
    if (new URL(req.url).pathname === "/__sql") {
      const { sql } = await req.json(); const r = await (globalThis as any).__db.query(sql);
      return new Response(JSON.stringify(r.rows));
    }
    return h(req);
  });
await import("../../functions/pawfolio-sitter-inbox/index.ts");
