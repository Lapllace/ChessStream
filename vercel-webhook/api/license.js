/**
 * Vercel Serverless Function — ativação e validação de licenças.
 *
 * URL: https://seu-projeto.vercel.app/api/license
 *
 * Modelo de negócio:
 *   - assinatura mensal vendida pelo próprio fornecedor (beta fechado);
 *   - chave no formato CSH-XXXX-XXXX-XXXX, gerada manualmente no painel
 *     do Supabase;
 *   - 30 dias de validade a partir da PRIMEIRA ativação;
 *   - sem vínculo por máquina (o streamer pode trocar de PC e reativar);
 *   - o app consulta este endpoint a cada 3 dias e mantém cache local.
 *
 * Segurança:
 *   - usa service_role (SUPABASE_SERVICE_ROLE_KEY ou SUPABASE_SERVICE_KEY).
 *     Essa chave ignora RLS e NUNCA pode ir para o cliente;
 *   - a anon key não tem acesso à tabela public.licenses.
 *
 * Variáveis de ambiente:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY (ou SUPABASE_SERVICE_KEY)
 */

const { createClient } = require('@supabase/supabase-js');

const LICENSE_DURATION_DAYS = 30;
const LICENSE_KEY_PATTERN = /^CSH-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

let supabase = null;

function getSupabase() {
  if (supabase) return supabase;

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    || process.env.SUPABASE_SERVICE_KEY;

  if (!url || !serviceKey) {
    throw new Error('SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY não configurados.');
  }

  supabase = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return supabase;
}

function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body;
}

/** Normaliza para o formato canônico (aceita colagem sem hífens). */
function normalizeKey(value) {
  const raw = String(value || '').trim().toUpperCase();
  const compact = raw.replace(/[^A-Z0-9]/g, '');

  if (compact.length === 15 && compact.startsWith('CSH')) {
    return `CSH-${compact.slice(3, 7)}-${compact.slice(7, 11)}-${compact.slice(11, 15)}`;
  }

  return raw;
}

async function fetchLicense(key) {
  const { data, error } = await getSupabase()
    .from('licenses')
    .select('license_key, email, status, activated_at, expires_at, last_check_at')
    .eq('license_key', key)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/** Resolve o prazo real, inclusive para chaves legadas sem expires_at. */
function resolveExpiry(license) {
  if (license.expires_at) {
    const date = new Date(license.expires_at);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (license.activated_at) {
    const activated = new Date(license.activated_at);
    if (!Number.isNaN(activated.getTime())) {
      return new Date(activated.getTime() + LICENSE_DURATION_DAYS * DAY_MS);
    }
  }

  return null;
}

async function touchLastCheck(key) {
  const { error } = await getSupabase()
    .from('licenses')
    .update({ last_check_at: new Date().toISOString() })
    .eq('license_key', key);

  // Falhar ao gravar o carimbo não invalida a licença do cliente.
  if (error) console.warn('[License] Falha ao atualizar last_check_at:', error.message);
}

async function markExpired(key) {
  const { error } = await getSupabase()
    .from('licenses')
    .update({ status: 'expired' })
    .eq('license_key', key);

  if (error) console.warn('[License] Falha ao marcar licença como expirada:', error.message);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { key, action } = readBody(req);

  if (!key || typeof key !== 'string') {
    return res.status(400).json({ error: 'Chave inválida.' });
  }

  const normalizedKey = normalizeKey(key);

  if (!LICENSE_KEY_PATTERN.test(normalizedKey)) {
    return res.status(400).json({
      error: 'Formato de chave inválido. Use o formato CSH-XXXX-XXXX-XXXX.',
    });
  }

  try {
    const now = new Date();
    let license = await fetchLicense(normalizedKey);

    if (!license) {
      return res.status(404).json({ error: 'Chave não encontrada.' });
    }

    if (license.status === 'revoked') {
      return res.status(403).json({
        valid: false,
        revoked: true,
        message: 'Esta licença foi revogada. Entre em contato para regularizar.',
      });
    }

    // ── Primeira ativação ────────────────────────────────────────────────
    if (!license.activated_at) {
      if (action !== 'activate') {
        return res.status(200).json({
          valid: false,
          needsActivation: true,
          message: 'Chave encontrada. Confirme a ativação.',
        });
      }

      const activatedAt = now.toISOString();
      const expiresAt = new Date(
        now.getTime() + LICENSE_DURATION_DAYS * DAY_MS
      ).toISOString();

      // O filtro activated_at IS NULL evita que duas ativações simultâneas
      // criem prazos diferentes para a mesma chave.
      const { data: updated, error: updateError } = await getSupabase()
        .from('licenses')
        .update({
          activated_at: activatedAt,
          expires_at: expiresAt,
          last_check_at: activatedAt,
          status: 'active',
        })
        .eq('license_key', normalizedKey)
        .is('activated_at', null)
        .select('activated_at, expires_at')
        .maybeSingle();

      if (updateError) throw updateError;

      if (updated) {
        return res.status(200).json({
          valid: true,
          activated: true,
          expiresAt: updated.expires_at,
          daysLeft: LICENSE_DURATION_DAYS,
          message: `Licença ativada! Válida por ${LICENSE_DURATION_DAYS} dias.`,
        });
      }

      // Outra requisição ativou a chave entre o SELECT e o UPDATE.
      license = await fetchLicense(normalizedKey);
      if (!license) {
        return res.status(404).json({ error: 'Chave não encontrada.' });
      }
      if (license.status === 'revoked') {
        return res.status(403).json({
          valid: false,
          revoked: true,
          message: 'Esta licença foi revogada. Entre em contato para regularizar.',
        });
      }
    }

    // ── Validação de chave já ativada ────────────────────────────────────
    const expiresAt = resolveExpiry(license);

    // O prazo é a fonte da verdade. Assim o dono renova apenas editando
    // `expires_at` no painel do Supabase, sem precisar mexer no status.
    if (!expiresAt || now >= expiresAt) {
      if (license.status !== 'expired') await markExpired(normalizedKey);

      return res.status(403).json({
        valid: false,
        expired: true,
        expiresAt: expiresAt ? expiresAt.toISOString() : license.expires_at || null,
        message: 'Licença expirada. Entre em contato para renovar.',
      });
    }

    if (license.status !== 'active') {
      // Prazo estendido manualmente: volta a valer sem edição extra.
      const { error: reactivateError } = await getSupabase()
        .from('licenses')
        .update({ status: 'active' })
        .eq('license_key', normalizedKey);

      if (reactivateError) {
        console.warn('[License] Falha ao reativar licença renovada:', reactivateError.message);
      }
    }

    const daysLeft = Math.max(
      0,
      Math.ceil((expiresAt.getTime() - now.getTime()) / DAY_MS)
    );

    await touchLastCheck(normalizedKey);

    return res.status(200).json({
      valid: true,
      activated: false,
      expiresAt: expiresAt.toISOString(),
      daysLeft,
      message: daysLeft <= 7
        ? `⚠️ Sua licença expira em ${daysLeft} dia(s).`
        : `Licença válida por mais ${daysLeft} dia(s).`,
    });
  } catch (err) {
    console.error('[License] Erro:', err.message);
    return res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
};
