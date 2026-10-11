// Laporan Harian Moody Space — Netlify Function + Netlify Blobs
// Endpoint: /api/finance  (GET ?probe=1 untuk cek, POST {action, code, ...} untuk semua aksi)
// Environment variables (Site configuration → Environment variables):
//   MOODY_ADMIN_CODE  kode login Owner/admin (WAJIB diganti; default "MOODY2026")
//   MOODY_SALT        teks acak untuk mengacak kode (opsional)
import { getStore } from "@netlify/blobs";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const num = (v) => Math.max(0, Math.round(Number(v) || 0));
const str = (v, n = 200) => String(v ?? "").trim().slice(0, n);
const enc = new TextEncoder();

async function hashCode(code) {
  const salt = Netlify.env.get("MOODY_SALT") || "moody-space";
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(salt + ":" + String(code).trim()));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const adminCode = () => Netlify.env.get("MOODY_ADMIN_CODE") || "MOODY2026";

async function getProfiles(store) {
  return (await store.get("profiles", { type: "json" })) || [];
}
async function getConfig(store) {
  return { kpi: 20, ...((await store.get("config", { type: "json" })) || {}) };
}
async function getKatalog(store) {
  const k = await store.get("katalog", { type: "json" });
  return Array.isArray(k) && k.length ? k : null;
}

async function auth(store, code) {
  code = String(code || "").trim();
  if (!code) return null;
  if (code === adminCode()) return { id: "owner", name: "Owner", role: "admin" };
  const h = await hashCode(code);
  const p = (await getProfiles(store)).find((p) => p.codeHash === h && p.active !== false);
  return p ? { id: p.id, name: p.name, role: p.role === "admin" ? "admin" : "staff" } : null;
}

async function loadMonth(store, month) {
  const { blobs } = await store.list({ prefix: "r/" + month + "/" });
  return (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })))).filter(Boolean);
}

function cleanReport(d, date, who, by) {
  const income = d.income || {};
  return {
    date,
    userId: who.id,
    userName: who.name,
    openingCash: num(d.openingCash),
    income: { qris: num(income.qris), transfer: num(income.transfer), cash: num(income.cash) },
    cashToCashless: num(d.cashToCashless),
    expenses: (Array.isArray(d.expenses) ? d.expenses : [])
      .map((e) => ({ desc: str(e.desc, 120), amount: num(e.amount), method: e.method === "cashless" ? "cashless" : "cash" }))
      .filter((e) => e.desc || e.amount)
      .slice(0, 100),
    itemsSold: num(d.itemsSold),
    items: (Array.isArray(d.items) ? d.items : [])
      .map((i) => ({ name: str(i.name, 120), qty: num(i.qty), price: num(i.price), hpp: num(i.hpp), cat: str(i.cat, 40) }))
      .filter((i) => i.name && i.qty > 0)
      .slice(0, 200),
    notes: str(d.notes, 2000),
    updatedAt: new Date().toISOString(),
    updatedBy: by.name,
  };
}

const publicProfile = (p) => ({ id: p.id, name: p.name, role: p.role || "staff", active: p.active !== false, hasCode: !!p.codeHash });

export default async (req) => {
  const store = getStore({ name: "moody-finance", consistency: "strong" });

  if (req.method === "GET") return json({ ok: true, service: "moody-finance" });
  if (req.method !== "POST") return json({ ok: false, error: "method tidak didukung" }, 405);

  let b;
  try { b = await req.json(); } catch { return json({ ok: false, error: "data tidak valid" }, 400); }

  const me = await auth(store, b.code);
  if (!me) return json({ ok: false, error: "login" });
  const isAdmin = me.role === "admin";
  const deny = () => json({ ok: false, error: "Hanya admin yang bisa melakukan ini." });

  switch (b.action) {
    case "login":
      return json({ ok: true, me, config: await getConfig(store), katalog: await getKatalog(store) });

    case "load": {
      const month = str(b.month, 7);
      if (!MONTH_RE.test(month)) return json({ ok: false, error: "bulan tidak valid" }, 400);
      let reports = await loadMonth(store, month);
      if (!isAdmin) reports = reports.filter((r) => r.userId === me.id);
      const out = { ok: true, me, reports, config: await getConfig(store), katalog: await getKatalog(store) };
      if (isAdmin) out.profiles = (await getProfiles(store)).map(publicProfile);
      return json(out);
    }

    case "saveReport": {
      const date = str(b.date, 10);
      if (!DATE_RE.test(date)) return json({ ok: false, error: "tanggal tidak valid" }, 400);
      let who = me;
      if (isAdmin && b.userId && b.userId !== me.id) {
        const p = (await getProfiles(store)).find((p) => p.id === b.userId);
        if (!p) return json({ ok: false, error: "profil tidak ditemukan" });
        who = { id: p.id, name: p.name };
      }
      const rep = cleanReport(b.data || {}, date, who, me);
      await store.setJSON(`r/${date.slice(0, 7)}/${date}__${who.id}`, rep);
      return json({ ok: true, report: rep });
    }

    case "deleteReport": {
      const date = str(b.date, 10);
      const uid = isAdmin && b.userId ? str(b.userId, 64) : me.id;
      if (!DATE_RE.test(date)) return json({ ok: false, error: "tanggal tidak valid" }, 400);
      await store.delete(`r/${date.slice(0, 7)}/${date}__${uid}`);
      return json({ ok: true });
    }

    case "saveProfile": {
      if (!isAdmin) return deny();
      const profiles = await getProfiles(store);
      const name = str(b.name, 40);
      if (!name) return json({ ok: false, error: "Nama wajib diisi." });
      const id = b.id ? str(b.id, 64) : "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      let p = profiles.find((x) => x.id === id);
      if (!p) { p = { id }; profiles.push(p); }
      p.name = name;
      p.role = b.role === "admin" ? "admin" : "staff";
      p.active = b.active !== false;
      const code = str(b.newCode, 40);
      if (code) {
        if (code.length < 4) return json({ ok: false, error: "Kode minimal 4 karakter." });
        if (code === adminCode()) return json({ ok: false, error: "Kode ini sudah dipakai." });
        const h = await hashCode(code);
        if (profiles.some((x) => x.id !== id && x.codeHash === h)) return json({ ok: false, error: "Kode ini sudah dipakai orang lain." });
        p.codeHash = h;
      }
      if (!p.codeHash) return json({ ok: false, error: "Profil baru wajib diberi kode login." });
      await store.setJSON("profiles", profiles);
      return json({ ok: true, profiles: profiles.map(publicProfile) });
    }

    case "deleteProfile": {
      if (!isAdmin) return deny();
      const profiles = (await getProfiles(store)).filter((p) => p.id !== b.id);
      await store.setJSON("profiles", profiles);
      return json({ ok: true, profiles: profiles.map(publicProfile) });
    }

    case "saveConfig": {
      if (!isAdmin) return deny();
      const cfg = { ...(await getConfig(store)), kpi: Math.max(1, num(b.config?.kpi) || 20) };
      await store.setJSON("config", cfg);
      return json({ ok: true, config: cfg });
    }

    case "saveKatalog": {
      if (!isAdmin) return deny();
      const items = (Array.isArray(b.items) ? b.items : [])
        .filter((i) => i && i.name).slice(0, 500)
        .map((i) => ({ name: str(i.name, 120), price: num(i.price), hpp: num(i.hpp), cat: str(i.cat || "Lainnya", 40) }));
      await store.setJSON("katalog", items);
      return json({ ok: true, katalog: items });
    }

    default:
      return json({ ok: false, error: "aksi tidak dikenal" }, 400);
  }
};

export const config = { path: "/api/finance" };
