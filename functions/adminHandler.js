// ============================================================================
// ADMIN VERIFIKASI SKBT V2
// Role: Sekretaris Inspektorat -> Inspektur
// Server-side session HMAC untuk melindungi endpoint admin.
// ============================================================================

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

const SECRETARY_ROLE = 'sekretaris';
const INSPECTOR_ROLE = 'inspektur';
const SESSION_TTL_SECONDS = 8 * 60 * 60;

let schemaReadyPromise = null;
async function addColumnSafe(db, sql) {
  try { await db.prepare(sql).run(); }
  catch (error) { if (!String(error?.message || error).toLowerCase().includes('duplicate column name')) throw error; }
}
async function ensureSchema(env) {
  if (schemaReadyPromise) return schemaReadyPromise;
  schemaReadyPromise = (async () => {
    const s = await env.DB.prepare('PRAGMA table_info(skbt_submissions)').all();
    const d = await env.DB.prepare('PRAGMA table_info(skbt_documents)').all();
    const sn = new Set((s.results || []).map(x => x.name));
    const dn = new Set((d.results || []).map(x => x.name));

    const submissionAdds = {
      pangkat_golongan: 'TEXT', nomor_hp: 'TEXT', gmail: 'TEXT', keperluan: 'TEXT',
      catatan_sekretaris: 'TEXT', catatan_inspektur: 'TEXT', gdrive_folder_id: 'TEXT',
      gdocs_id: 'TEXT', gdocs_url: 'TEXT', gdocs_pdf_url: 'TEXT', gdocs_docx_url: 'TEXT',
    };
    for (const [name, type] of Object.entries(submissionAdds)) {
      if (!sn.has(name)) await addColumnSafe(env.DB, `ALTER TABLE skbt_submissions ADD COLUMN ${name} ${type}`);
    }

    const docAdds = { r2_path: 'TEXT', verification_status: "TEXT DEFAULT 'pending'", verification_note: "TEXT DEFAULT ''" };
    for (const [name, type] of Object.entries(docAdds)) {
      if (!dn.has(name)) await addColumnSafe(env.DB, `ALTER TABLE skbt_documents ADD COLUMN ${name} ${type}`);
    }
    await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_skbt_documents_submission ON skbt_documents(submission_id)').run();
    await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_skbt_documents_code ON skbt_documents(submission_id, dokumen_code)').run();
    await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_skbt_submissions_status ON skbt_submissions(status_verifikasi)').run();
    await env.DB.prepare("UPDATE skbt_submissions SET status_verifikasi = REPLACE(REPLACE(status_verifikasi, 'Irban', 'Sekretaris Inspektorat'), 'Verifikasi Sekretaris Inspektorat Sekretaris Inspektorat', 'Verifikasi Sekretaris Inspektorat'), current_level = CASE WHEN status_verifikasi LIKE '%Sekretaris Inspektorat%' THEN 1 ELSE current_level END WHERE status_verifikasi LIKE '%Irban%'").run();
  })().catch(error => { schemaReadyPromise = null; throw error; });
  return schemaReadyPromise;
}

function bytesToBase64Url(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function base64UrlToBytes(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(base64);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}
async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  return crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
}
async function createSession(env, role, username) {
  const secret = env.ADMIN_SESSION_SECRET || `${env.SEKRETARIS_PASSWORD || ''}|${env.INSPEKTUR_PASSWORD || ''}`;
  if (!secret || secret === '|') throw new Error('ADMIN_SESSION_SECRET belum dikonfigurasi.');
  const payload = { role, username, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS };
  const raw = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = bytesToBase64Url(new Uint8Array(await hmac(secret, raw)));
  return `${raw}.${sig}`;
}
async function verifySession(env, request) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const secret = env.ADMIN_SESSION_SECRET || `${env.SEKRETARIS_PASSWORD || ''}|${env.INSPEKTUR_PASSWORD || ''}`;
  if (!secret || secret === '|') return null;
  try {
    const [raw, sigText] = parts;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('HMAC', key, base64UrlToBytes(sigText), new TextEncoder().encode(raw));
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(raw)));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (![SECRETARY_ROLE, INSPECTOR_ROLE].includes(payload.role)) return null;
    return payload;
  } catch (_) { return null; }
}

function statusAllowed(role, status) {
  if (role === SECRETARY_ROLE) {
    return ['Draft', 'Sedang Verifikasi', 'Diverifikasi oleh Sekretaris Inspektorat', 'Menunggu Persetujuan Inspektur', 'Ditolak'].includes(status);
  }
  if (role === INSPECTOR_ROLE) {
    return ['Menunggu Persetujuan Inspektur', 'Disetujui oleh Inspektur', 'Ditolak'].includes(status);
  }
  return false;
}

function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#039;', '"':'&quot;' }[c]));
}

async function sendStatusEmail(env, submission, newStatus, catatan = '') {
  if (!env.RESEND_API_KEY || !submission.gmail) return;
  try {
    let subject = `Update Status Pengajuan SKBT - ${submission.nomor_pengajuan}`;
    let headline = 'Update Status Pengajuan SKBT';
    let message = `Status pengajuan Anda sekarang: <b>${escapeHtml(newStatus)}</b>`;
    if (newStatus === 'Disetujui oleh Inspektur') {
      subject = `SKBT DISETUJUI - ${submission.nomor_pengajuan}`;
      headline = 'PENGAJUAN SKBT DISETUJUI';
      message = 'Pengajuan SKBT Anda telah <b>DISETUJUI oleh Inspektur</b>.';
    } else if (newStatus === 'Ditolak') {
      subject = `Pengajuan SKBT Ditolak - ${submission.nomor_pengajuan}`;
      headline = 'PENGAJUAN SKBT DITOLAK';
      message = 'Mohon menindaklanjuti catatan verifikasi pada portal pengajuan SKBT.';
    }
    const html = `<div style="font-family:Arial,sans-serif;padding:20px;background:#f5f7fa"><h2 style="color:#173f3b">${headline}</h2><p>Nomor Pengajuan: <b>${escapeHtml(submission.nomor_pengajuan)}</b></p><p>${message}</p>${catatan ? `<p><b>Catatan:</b> ${escapeHtml(catatan)}</p>` : ''}<p>Form dan dokumen dapat dilihat melalui portal pengajuan SKBT.</p></div>`;
    await fetch('https://api.resend.com/emails', {
      method:'POST', headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`,'Content-Type':'application/json'},
      body:JSON.stringify({from:'Pengajuan SKBT <onboarding@resend.dev>',to:submission.gmail,subject,html})
    });
  } catch (error) { console.error('Gagal kirim email status:', error); }
}

export const onRequest = async ({ request, env }) => {
  const url = new URL(request.url);
  let params = {};
  let action = url.searchParams.get('action') || '';

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type, Authorization' } });
  }
  if (request.method === 'POST') {
    try { params = await request.json(); if (!action && params.action) action = params.action; }
    catch (_) { return jsonResponse({status:'error',msg:'Invalid JSON body'},400); }
  } else url.searchParams.forEach((value,key)=>{params[key]=value});

  try {
    await ensureSchema(env);

    if (action === 'adminLogin') {
      const { username = '', password = '', requested_role = '' } = params;
      const secretaryUsername = env.SEKRETARIS_USERNAME || 'sekretaris.inspektorat';
      const secretaryPassword = env.SEKRETARIS_PASSWORD;
      const inspectorUsername = env.INSPEKTUR_USERNAME;
      const inspectorPassword = env.INSPEKTUR_PASSWORD;
      let role = '';

      if (username === secretaryUsername && password === secretaryPassword) role = SECRETARY_ROLE;
      if (username === inspectorUsername && password === inspectorPassword) role = INSPECTOR_ROLE;
      if (requested_role && role !== requested_role) return jsonResponse({status:'error',msg:'Username/password tidak sesuai dengan role yang dipilih.'},401);
      if (!role) return jsonResponse({status:'error',msg:'Username atau password salah.'},401);

      const token = await createSession(env, role, username);
      return jsonResponse({status:'success',role,msg:'Login berhasil',token,expires_in:SESSION_TTL_SECONDS});
    }

    const session = await verifySession(env, request);
    if (!session) return jsonResponse({status:'error',msg:'Sesi admin tidak valid atau sudah kedaluwarsa. Silakan login kembali.'},401);

    switch (action) {
      case 'adminGetAllPengajuan': {
        const { status } = params;
        let query = 'SELECT * FROM skbt_submissions';
        if (status && status !== 'all') query += ' WHERE status_verifikasi = ?';
        query += ' ORDER BY created_at DESC';
        const stmt = status && status !== 'all' ? env.DB.prepare(query).bind(status) : env.DB.prepare(query);
        const { results } = await stmt.all();
        return jsonResponse(results || []);
      }

      case 'adminGetPengajuanById': {
        const { id } = params;
        const submission = await env.DB.prepare('SELECT * FROM skbt_submissions WHERE id = ?').bind(id).first();
        if (!submission) return jsonResponse({status:'error',msg:'Pengajuan tidak ditemukan.'},404);
        const docs = await env.DB.prepare('SELECT * FROM skbt_documents WHERE submission_id = ? ORDER BY dokumen_code, id').bind(id).all();
        return jsonResponse({status:'success',submission,documents:docs.results||[]});
      }

      case 'adminUpdateStatusPengajuan': {
        const { id, status, catatan = '' } = params;
        if (!statusAllowed(session.role,status)) return jsonResponse({status:'error',msg:'Role Anda tidak berhak menetapkan status tersebut.'},403);
        const sub = await env.DB.prepare('SELECT * FROM skbt_submissions WHERE id = ?').bind(id).first();
        if (!sub) return jsonResponse({status:'error',msg:'Pengajuan tidak ditemukan.'},404);

        if (session.role === SECRETARY_ROLE && status === 'Menunggu Persetujuan Inspektur') {
          const { results } = await env.DB.prepare("SELECT dokumen_code, COUNT(*) AS jumlah FROM skbt_documents WHERE submission_id = ? GROUP BY dokumen_code").bind(id).all();
          const counts = Object.fromEntries((results||[]).map(r=>[r.dokumen_code,Number(r.jumlah)]));
          const missing = ['SKPangkat','SKJabatan','SuratRekomendasiMutasi'].filter(code => !counts[code]);
          if (missing.length) return jsonResponse({status:'error',msg:'Dokumen wajib belum lengkap. Periksa pengajuan sebelum diteruskan ke Inspektur.'},400);
        }

        const updates = session.role === SECRETARY_ROLE
          ? 'status_verifikasi = ?, current_level = 1, catatan_sekretaris = ?'
          : 'status_verifikasi = ?, current_level = 2, catatan_inspektur = ?';
        await env.DB.prepare(`UPDATE skbt_submissions SET ${updates} WHERE id = ?`).bind(status,catatan,id).run();
        await env.DB.prepare('INSERT INTO skbt_verification_logs (submission_id, level_verifikasi, verifier_name, status, catatan) VALUES (?, ?, ?, ?, ?)')
          .bind(id, session.role === SECRETARY_ROLE ? 1 : 2, session.username, status, catatan).run();
        await sendStatusEmail(env, sub, status, catatan);
        return jsonResponse({status:'success',msg:'Status berhasil diperbarui.'});
      }

      case 'adminUpdateDokumenVerifikasi': {
        if (session.role !== SECRETARY_ROLE) return jsonResponse({status:'error',msg:'Verifikasi dokumen hanya dapat dilakukan oleh Sekretaris Inspektorat.'},403);
        const { doc_id, status, catatan = '' } = params;
        if (!['pending','approved','rejected'].includes(status)) return jsonResponse({status:'error',msg:'Status dokumen tidak valid.'},400);
        const doc = await env.DB.prepare('SELECT id FROM skbt_documents WHERE id = ?').bind(doc_id).first();
        if (!doc) return jsonResponse({status:'error',msg:'Dokumen tidak ditemukan.'},404);
        await env.DB.prepare('UPDATE skbt_documents SET verification_status = ?, verification_note = ? WHERE id = ?').bind(status,catatan,doc_id).run();
        return jsonResponse({status:'success',msg:'Verifikasi dokumen berhasil disimpan.'});
      }

      default:
        return jsonResponse({status:'error',msg:'Aksi tidak dikenal.'},404);
    }
  } catch (error) {
    console.error('Error adminHandler:',error);
    return jsonResponse({status:'error',msg:'Error server: '+error.message},500);
  }
};
