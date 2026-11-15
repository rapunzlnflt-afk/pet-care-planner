// End-to-end contract test: intake-crypto.js (unchanged) under Node against a server.
// Usage: INTAKE_CRYPTO=/path/to/intake-crypto.js node e2e.mjs <fnUrl> <mock|fn> <hookBase>
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const [URL_, MODE, HOOK] = process.argv.slice(2);
globalThis.PAWFOLIO_INTAKE_FN_URL = URL_;
const P = require(process.env.INTAKE_CRYPTO || '../../../intake-crypto.js');
let pass = 0, fail = 0;
const t = (name, cond, extra='') => { if (cond) pass++; else { fail++; console.log('FAIL', name, extra); } };
const raw = async (body, method='POST') => { const r = await fetch(URL_, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? JSON.stringify(body) : undefined }); let j=null; try { j = await r.json(); } catch {} return { s: r.status, j, h: r.headers }; };
const expectErr = async (name, p, status, error) => { try { await p; t(name, false, 'no error'); } catch (e) { t(name, e.status === status && e.message === error, `${e.status} ${e.message}`); } };
const age = async (inbox, days) => MODE === 'mock'
  ? fetch(HOOK + '/__test/age', { method: 'POST', body: JSON.stringify({ inbox, days }) })
  : fetch(HOOK + '/__sql', { method: 'POST', body: JSON.stringify({ sql: `update pawfolio_sitter_submissions set created_at = created_at - interval '${days} days' where inbox = '${inbox}'` }) });
const sql = async (q) => (await fetch(HOOK + '/__sql', { method: 'POST', body: JSON.stringify({ sql: q }) })).json();

const payload = (n) => ({ kind: 'pawfolio-intake', v: 1, sentAt: new Date().toISOString(), source: 'web', clientId: 'cid-sam-' + n,
  sitter: { name: 'Happy Tails Pet Sitting', phone: '555-0100', email: 'hello@happytails.example' },
  client: { name: 'Sam Taylor', phone: '555-0123', email: 'sam@example.com', address: '12 Elm St', phone2: '' },
  emergency: { name: 'Alex Taylor', rel: 'Sibling', phone: '555-0199', hasKey: 'yes' },
  vet: { name: 'Elm Vet', phone: '555-0111', address: '' }, emergencyVet: { name: '', phone: '', address: '' },
  home: { entry: 'Side door', alarm: '1234', wifi: '', parking: '', supplies: '', offLimits: '', extra: '', notes: '' },
  authorization: { amount: '$500', signature: 'Sam Taylor', date: '2026-11-05', text: 'If my pet needs urgent care...' },
  pets: [ { name: 'Bella', kind: 'Dog (yellow Lab)', age: '4', weight: '62 lb', sex: 'F', chip: '', desc: '', food: '2 cups', treats: '', health: '', walk: '', behave: '', notes: '', rabies: '', insurance: '', meds: [ { name: 'Carprofen', dose: '75 mg', time: '8am', how: 'with food' } ], photo: '' },
          { name: 'Milo', kind: 'Cat (tabby)', age: '7', weight: '11 lb', sex: 'M', chip: '', desc: '', food: '', treats: '', health: '', walk: '', behave: '', notes: '', rabies: '', insurance: '', meds: [], photo: '' } ] });

// CORS preflight
{ const r = await fetch(URL_, { method: 'OPTIONS' }); t('options 204', r.status === 204, r.status); t('cors origin', r.headers.get('access-control-allow-origin') === '*'); }
t('GET 405', (await raw(null, 'GET')).s === 405);
{ const r = await fetch(URL_, { method: 'POST', body: '{nope' }); t('bad json 400', r.status === 400 && (await r.json()).error === 'bad_request'); }
{ const r = await raw({ action: 'zap' }); t('unknown action', r.s === 400 && r.j.error === 'unknown_action', JSON.stringify(r)); }

// register
const keys = await P.generateSitterKeys();
const reg = await P.register(keys, 'Happy Tails Pet Sitting');
t('register ok', reg.ok === true && reg.code === keys.code && /^[A-Z2-9]{8}$/.test(keys.code), JSON.stringify(reg));
t('register again idempotent', (await P.register(keys, 'Happy Tails Pet Sitting')).ok === true);
const thief = { ...keys, inboxSecret: 'x'.repeat(43) };
await expectErr('register wrong token 403', P.register(thief, 'evil'), 403, 'forbidden');
const keys2 = await P.generateSitterKeys();
const hash2 = await P.sha256Hex(keys2.inboxSecret);
{ const r = await raw({ action: 'register', inbox: keys2.inboxId, token_hash: hash2, public_key: keys2.publicKey, code: keys.code, label: 'Other' }); t('code collision 409', r.s === 409 && r.j.error === 'code_taken', JSON.stringify(r)); }
keys2.code = keys.code; // client must retry with a new code
t('client retries on 409', (await P.register(keys2, 'Other sitter')).ok && keys2.code !== keys.code);
{ const r = await raw({ action: 'register', inbox: 'short', token_hash: hash2, public_key: keys2.publicKey, code: 'ABCD2345' }); t('register bad inbox 400', r.s === 400); }
{ const r = await raw({ action: 'register', inbox: keys2.inboxId, token_hash: 'nothex', public_key: keys2.publicKey, code: 'ABCD2345' }); t('register bad hash 400', r.s === 400); }
{ const r = await raw({ action: 'register', inbox: keys2.inboxId, token_hash: hash2, public_key: 'abc', code: 'ABCD2345' }); t('register bad pubkey 400', r.s === 400); }
{ const r = await raw({ action: 'register', inbox: keys2.inboxId, token_hash: hash2, public_key: keys2.publicKey, code: 'ABCD0001' }); t('register bad code 400', r.s === 400); }

// lookup
const tgt = await P.lookupCode(P.fmtCode(keys.code));
t('lookup by XXXX-XXXX', tgt.inboxId === keys.inboxId && tgt.publicKey === keys.publicKey && tgt.label === 'Happy Tails Pet Sitting', JSON.stringify(tgt));
t('lookup lowercase', (await P.lookupCode(keys.code.toLowerCase())).inboxId === keys.inboxId);
await expectErr('lookup unknown 404', P.lookupCode('ZZZZ-ZZZZ'), 404, 'not_found');
await expectErr('lookup malformed 404', P.lookupCode('12'), 404, 'not_found');

// link round trip
const frag = P.sendFragment(keys.inboxId, keys.publicKey);
t('fragment parses', JSON.stringify(P.parseSendTarget(frag)) === JSON.stringify({ inboxId: keys.inboxId, publicKey: keys.publicKey }));

// submit + list + decrypt + ack
const s1 = await P.submit(tgt, payload(1));
const s2 = await P.submit(P.parseSendTarget(frag), payload(2));
t('submit ok', s1.ok && /^[0-9a-f-]{36}$/.test(s1.id) && s2.ok);
await expectErr('submit unknown inbox 404', P.submit({ inboxId: 'A'.repeat(22), publicKey: keys.publicKey }, payload(9)), 404, 'not_found');
const goodEnv = await P.encryptFor(keys.publicKey, { hi: 1 });
for (const [name, env] of [['no ct', { ...goodEnv, ct: undefined }], ['v2', { ...goodEnv, v: 2 }], ['bad epk', { ...goodEnv, epk: 'x' }], ['bad iv', { ...goodEnv, iv: 'x' }], ['bad ct chars', { ...goodEnv, ct: '$'.repeat(40) }], ['array', [1]]]) {
  const r = await raw({ action: 'submit', inbox: keys.inboxId, envelope: env }); t('submit ' + name + ' 400', r.s === 400 && r.j.error === 'bad_envelope', JSON.stringify(r));
}
{ const r = await raw({ action: 'submit', inbox: keys.inboxId, envelope: { ...goodEnv, ct: 'A'.repeat(1500001) } }); t('submit too_large 413', r.s === 413 && r.j.error === 'too_large', JSON.stringify(r)); }
{ const r = await raw({ action: 'submit', inbox: keys.inboxId, envelope: { ...goodEnv, ct: 'A'.repeat(1800000) } }); t('body too_large 413', r.s === 413 && r.j.error === 'too_large', r.s); }

await expectErr('list bad token 403', P.list(thief), 403, 'forbidden');
await expectErr('list other inbox token 403', P.list({ ...keys2, inboxId: keys.inboxId }), 403, 'forbidden');
const L = await P.list(keys);
t('list 2 oldest first', L.items.length === 2 && L.items[0].id === s1.id && L.items[1].id === s2.id && L.more === false, JSON.stringify(L).slice(0, 200));
t('list item shape', L.items.every(i => i.id && !isNaN(Date.parse(i.created_at)) && i.envelope && i.envelope.epk && i.envelope.iv && i.envelope.ct));
const dec = await Promise.all(L.items.map(i => P.decryptWith(keys.privateJwk, i.envelope)));
t('decrypt matches', dec[0].clientId === 'cid-sam-1' && dec[1].pets[1].name === 'Milo' && dec[0].client.name === 'Sam Taylor' && dec[0].pets[0].meds[0].name === 'Carprofen');
let wrongKeyFails = false; try { await P.decryptWith(keys2.privateJwk, L.items[0].envelope); } catch { wrongKeyFails = true; }
t('other sitter cannot decrypt', wrongKeyFails);
await expectErr('ack bad token 403', P.ack(thief, [s1.id]), 403, 'forbidden');
await expectErr('ack non-uuid 400', P.ack(keys, ['nope']), 400, 'bad_request');
await expectErr('ack 51 ids 400', P.ack(keys, Array.from({ length: 51 }, () => crypto.randomUUID())), 400, 'bad_request');
await expectErr('ack not array 400', P.ack(keys, 'x'), 400, 'bad_request');
t('ack others rows deletes 0', (await P.ack(keys2, [s1.id])).deleted === 0);
t('ack empty', (await P.ack(keys, [])).deleted === 0);
const A = await P.ack(keys, [s1.id, s2.id, crypto.randomUUID()]);
t('ack deletes 2', A.ok === true && A.deleted === 2, JSON.stringify(A));
t('list empty after ack', (await P.list(keys)).items.length === 0);

// 60 day purge
const old = await P.submit(tgt, payload(3)); await age(keys.inboxId, 61);
const fresh = await P.submit(tgt, payload(4));
const L2 = await P.list(keys);
t('purge >60d on list', L2.items.length === 1 && L2.items[0].id === fresh.id, JSON.stringify(L2.items.map(i => i.id)));
await P.ack(keys, [fresh.id]);

// limits: 100 pending, list max 50
const small = await P.encryptFor(keys.publicKey, { s: 1 });
const resetRate = async () => { if (MODE === 'fn') await sql('delete from pawfolio_sitter_rate'); };
await resetRate();
for (let i = 0; i < 100; i++) { if (i % 25 === 0) await resetRate(); const r = await raw({ action: 'submit', inbox: keys.inboxId, envelope: small }); if (r.s !== 200) { t('fill ' + i, false, JSON.stringify(r)); break; } }
await expectErr('inbox_full 429', P.submit(tgt, payload(5)), 429, 'inbox_full');
const L3 = await P.list(keys);
t('list max 50 + more', L3.items.length === 50 && L3.more === true, L3.items.length);
let total = 0; for (;;) { const l = await P.list(keys); if (!l.items.length) break; total += (await P.ack(keys, l.items.map(i => i.id))).deleted; }
t('drain 100 via list/ack loop', total === 100, total);

// list response size budget (12M chars): 9 x 1.5M -> 8 then 1
const big = { ...small, ct: 'A'.repeat(1500000) };
await resetRate();
for (let i = 0; i < 9; i++) await raw({ action: 'submit', inbox: keys.inboxId, envelope: big });
const B1 = await P.list(keys); t('budget first page 8', B1.items.length === 8 && B1.more === true, B1.items.length);
await P.ack(keys, B1.items.map(i => i.id));
const B2 = await P.list(keys); t('budget second page 1', B2.items.length === 1 && B2.more === false);
await P.ack(keys, B2.items.map(i => i.id));

if (MODE === 'fn') {
  // ---- rate limits (migration 0010). Local requests carry no client IP, so
  // per-IP limits are tested by sending x-forwarded-for directly.
  const ipReq = async (ip, body) => { const r = await fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip + ', 10.0.0.1' }, body: JSON.stringify(body) }); let j = null; try { j = await r.json(); } catch {} return { s: r.status, j, h: r.headers }; };
  await resetRate();
  let okLookups = 0; for (let i = 0; i < 30; i++) { const r = await ipReq('203.0.113.7', { action: 'lookup', code: i % 2 ? keys.code : 'ZZZZZZZZ' }); if (r.s === 200 || r.s === 404) okLookups++; }
  t('30 lookups allowed per IP', okLookups === 30, okLookups);
  { const r = await ipReq('203.0.113.7', { action: 'lookup', code: keys.code }); t('31st lookup 429 rate_limited', r.s === 429 && r.j.error === 'rate_limited' && Number(r.h.get('retry-after')) > 0, JSON.stringify(r.j) + ' ' + r.h.get('retry-after')); }
  { const r = await ipReq('203.0.113.7', { action: 'lookup', code: 'ab' }); t('malformed guesses also limited', r.s === 429, r.s); }
  { const r = await ipReq('198.51.100.9', { action: 'lookup', code: keys.code }); t('other IP unaffected', r.s === 200, r.s); }
  try { await P.lookupCode(keys.code); t('no-IP requests skip per-IP limit', true); } catch (e) { t('no-IP requests skip per-IP limit', false, e.message); }
  { const rows = await sql(`select bucket from pawfolio_sitter_rate where bucket like 'lookup:ip:%' limit 1`); t('IP stored only as hash', rows[0] && /^lookup:ip:[0-9a-f]{32}$/.test(rows[0].bucket) && !rows[0].bucket.includes('203.0'), JSON.stringify(rows)); }
  // global lookup cap: 2000/hour across all IPs (simulate by pre-filling the counter)
  await resetRate();
  await sql(`insert into pawfolio_sitter_rate (bucket, window_start, hits) values ('lookup:all:all', to_timestamp(floor(extract(epoch from now()) / 3600) * 3600), 2000)`);
  { const r = await ipReq('198.51.100.50', { action: 'lookup', code: keys.code }); t('global lookup cap 429', r.s === 429 && r.j.error === 'rate_limited', r.s); }
  // cf-connecting-ip wins over a faked x-forwarded-for
  await resetRate();
  for (let i = 0; i < 30; i++) await fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.77', 'x-forwarded-for': '10.9.' + i + '.1' }, body: JSON.stringify({ action: 'lookup', code: keys.code }) });
  { const r = await fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.77', 'x-forwarded-for': '10.9.99.1' }, body: JSON.stringify({ action: 'lookup', code: keys.code }) }); t('faked x-forwarded-for does not dodge cf-connecting-ip', r.status === 429, r.status); }
  // register: 10 per IP per hour
  await resetRate();
  let regOk = 0; for (let i = 0; i < 10; i++) { const r = await ipReq('203.0.113.8', { action: 'register', inbox: keys.inboxId, token_hash: await P.sha256Hex(keys.inboxSecret), public_key: keys.publicKey, code: keys.code, label: 'Happy Tails Pet Sitting' }); if (r.s === 200) regOk++; }
  t('10 registers allowed per IP', regOk === 10, regOk);
  { const r = await ipReq('203.0.113.8', { action: 'register', inbox: keys.inboxId, token_hash: await P.sha256Hex(keys.inboxSecret), public_key: keys.publicKey, code: keys.code, label: 'x' }); t('11th register 429', r.s === 429 && r.j.error === 'rate_limited', r.s); }
  // submit: 20 per IP per hour
  await resetRate();
  let subOk = 0; for (let i = 0; i < 20; i++) { const r = await ipReq('203.0.113.9', { action: 'submit', inbox: keys.inboxId, envelope: small }); if (r.s === 200) subOk++; }
  t('20 submits allowed per IP', subOk === 20, subOk);
  { const r = await ipReq('203.0.113.9', { action: 'submit', inbox: keys.inboxId, envelope: small }); t('21st submit from IP 429', r.s === 429 && r.j.error === 'rate_limited', r.s); }
  // submit: 30 per inbox per hour, across IPs
  for (let i = 0; i < 10; i++) { const r = await ipReq('192.0.2.' + i, { action: 'submit', inbox: keys.inboxId, envelope: small }); if (r.s !== 200) { t('inbox submit ' + i, false, r.s); break; } }
  { const r = await ipReq('192.0.2.200', { action: 'submit', inbox: keys.inboxId, envelope: small }); t('31st submit to one inbox 429 from a new IP', r.s === 429 && r.j.error === 'rate_limited', r.s); }
  { const r = await ipReq('192.0.2.201', { action: 'submit', inbox: keys2.inboxId, envelope: await P.encryptFor(keys2.publicKey, { s: 1 }) }); t('other inbox unaffected', r.s === 200, r.s); }
  // list/ack are never limited
  for (let i = 0; i < 40; i++) await P.list(keys);
  t('list not limited', (await P.list(keys)).items.length > 0);
  for (const k of [keys, keys2]) { for (;;) { const l = await P.list(k); if (!l.items.length) break; await P.ack(k, l.items.map(i => i.id)); } }
  // rate function is not callable by anon/authenticated
  { const g = await sql(`select has_function_privilege('anon', 'public.pawfolio_sitter_rate_hit(text,integer,integer)', 'execute') a, has_function_privilege('authenticated', 'public.pawfolio_sitter_rate_hit(text,integer,integer)', 'execute') b, has_function_privilege('service_role', 'public.pawfolio_sitter_rate_hit(text,integer,integer)', 'execute') c`); t('rate fn: anon/auth no, service_role yes', g[0].a === false && g[0].b === false && g[0].c === true, JSON.stringify(g)); }
  // strict 100 cap: fill to 98, then 5 at once -> exactly 2 land
  await resetRate();
  await sql(`insert into pawfolio_sitter_submissions (inbox, envelope) select '${keys.inboxId}', '${JSON.stringify(small)}'::jsonb from generate_series(1, 98)`);
  const race = await Promise.all(Array.from({ length: 5 }, () => raw({ action: 'submit', inbox: keys.inboxId, envelope: small })));
  const landed = race.filter(r => r.s === 200).length, full = race.filter(r => r.s === 429 && r.j.error === 'inbox_full').length;
  t('race: exactly 2 land, 3 inbox_full', landed === 2 && full === 3, race.map(r => r.s + ':' + (r.j && r.j.error)).join(','));
  { const c = await sql(`select count(*)::int n from pawfolio_sitter_submissions where inbox = '${keys.inboxId}'`); t('never over 100', c[0].n === 100, c[0].n); }
  // trigger alone (bypassing the function's own check)
  { let blocked = false; try { const x = await fetch(HOOK + '/__sql', { method: 'POST', body: JSON.stringify({ sql: `insert into pawfolio_sitter_submissions (inbox, envelope) values ('${keys.inboxId}', '${JSON.stringify(small)}'::jsonb)` }) }); blocked = x.status >= 500; } catch { blocked = true; } t('trigger blocks the 101st directly', blocked); }
  await sql(`delete from pawfolio_sitter_submissions`);

  const r = await sql(`select last_seen_at, label, code from pawfolio_sitter_inboxes where inbox = '${keys.inboxId}'`);
  t('last_seen_at set', r[0] && r[0].last_seen_at && Date.now() - Date.parse(r[0].last_seen_at) < 60000, JSON.stringify(r));
  const c = await sql(`select count(*)::int n from pawfolio_sitter_submissions`); t('db empty at end', c[0].n === 0);
}
console.log(`${MODE}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
