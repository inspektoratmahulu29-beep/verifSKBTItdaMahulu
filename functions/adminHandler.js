// Helper response JSON yang aman (CORS)
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

// ============ KIRIM EMAIL KE PEMOHON ============
async function sendStatusEmail(env, submission, newStatus, catatan = '') {
  if (!env.RESEND_API_KEY || !submission.gmail) return;
  try {
    const emailBody = `<div style="font-family: Arial, sans-serif; background: #f4f7fb; padding: 20px;">
        <h2 style="color: #03045e;">Update Status Pengajuan SKBT</h2>
        <p>Nomor: <b>${submission.nomor_pengajuan}</b></p>
        <p>Status baru: <b style="color: #0077b6;">${newStatus}</b></p>
        ${catatan ? `<p>Catatan: ${catatan}</p>` : ''}
        <p>Silakan cek status pengajuan Anda di portal.</p>
      </div>`;

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Pengajuan SKBT <onboarding@resend.dev>',
        to: submission.gmail,
        subject: 'Update Status Pengajuan SKBT: ' + submission.nomor_pengajuan,
        html: emailBody
      })
    });
  } catch (e) { console.error('Gagal kirim email status:', e); }
}

// ============ HANDLER UTAMA ============
export const onRequest = async ({ request, env }) => {
  const url = new URL(request.url);
  let params = {};
  let action = url.searchParams.get('action') || '';

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    });
  }

  if (request.method === 'POST') {
    try {
      params = await request.json();
      if (!action && params.action) action = params.action;
    } catch (e) {
      return jsonResponse({ status: 'error', msg: 'Invalid JSON body' });
    }
  } else {
    url.searchParams.forEach((value, key) => { params[key] = value; });
  }

  try {
    switch (action) {
      // ============ LOGIN ADMIN (IRBAN & INSPEKTUR) ============
      case 'adminLogin': {
        const { username, password } = params;

        // Akun Irban
        if (username === 'Irbanwil28' && password === 'irbanwilayah28') {
          return jsonResponse({ status: 'success', role: 'irban', msg: 'Login berhasil sebagai Irban' });
        }

        // Akun Inspektur
        if (username === 'ItdakabMahulu' && password === 'ItdaMahulu28') {
          return jsonResponse({ status: 'success', role: 'inspektur', msg: 'Login berhasil sebagai Inspektur' });
        }

        return jsonResponse({ status: 'error', msg: 'Username atau password salah' });
      }

      // ============ AMBIL SEMUA PENGAJUAN ============
      case 'adminGetAllPengajuan': {
        const { status } = params;
        let query = "SELECT * FROM skbt_submissions";
        if (status && status !== 'all') {
          query += " WHERE status_verifikasi = ?";
        }
        query += " ORDER BY created_at DESC";
        const stmt = status && status !== 'all' ? env.DB.prepare(query).bind(status) : env.DB.prepare(query);
        const { results } = await stmt.all();
        return jsonResponse(results);
      }

      // ============ AMBIL DETAIL PENGAJUAN ============
      case 'adminGetPengajuanById': {
        const { id } = params;
        const sub = await env.DB.prepare("SELECT * FROM skbt_submissions WHERE id = ?").bind(id).first();
        const docs = await env.DB.prepare("SELECT * FROM skbt_documents WHERE submission_id = ?").bind(id).all();
        return jsonResponse({ submission: sub, documents: docs.results });
      }

      // ============ UPDATE STATUS PENGAJUAN ============
      case 'adminUpdateStatusPengajuan': {
        const { id, status, catatan } = params;
        const sub = await env.DB.prepare("SELECT * FROM skbt_submissions WHERE id = ?").bind(id).first();
        if (!sub) return jsonResponse({ status: 'error', msg: 'Pengajuan tidak ditemukan' });

        await env.DB.prepare("UPDATE skbt_submissions SET status_verifikasi = ? WHERE id = ?").bind(status, id).run();

        // Kirim email ke pemohon
        await sendStatusEmail(env, sub, status, catatan);

        return jsonResponse({ status: 'success', msg: 'Status berhasil diupdate' });
      }

      // ============ UPDATE VERIFIKASI PER DOKUMEN ============
      case 'adminUpdateDokumenVerifikasi': {
        const { doc_id, status, catatan } = params;
        if (!['pending', 'approved', 'rejected'].includes(status)) {
          return jsonResponse({ status: 'error', msg: 'Status dokumen tidak valid' });
        }

        await env.DB.prepare("UPDATE skbt_documents SET verification_status = ?, verification_note = ? WHERE id = ?")
          .bind(status, catatan || '', doc_id).run();

        return jsonResponse({ status: 'success', msg: 'Verifikasi dokumen berhasil disimpan' });
      }

      default:
        return jsonResponse({ status: 'error', msg: 'Aksi tidak dikenal' });
    }
  } catch (err) {
    console.error('Error di adminHandler:', err);
    return jsonResponse({ status: 'error', msg: 'Error: ' + err.message });
  }
};
