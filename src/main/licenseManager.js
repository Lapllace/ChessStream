/**
 * Licenciamento comercial — HWID + chave de ativação.
 *
 * Fluxo:
 *   1. A chave (CHESS-XXXX-XXXX-XXXX) é validada no Supabase do fornecedor
 *      pela RPC verify_and_activate_license() (SECURITY DEFINER).
 *   2. Na primeira ativação a RPC grava o HWID do computador na licença.
 *   3. O app guarda a chave cifrada com safeStorage e mantém um carimbo da
 *      última validação online para permitir 72h de uso offline.
 *
 * O HWID é um SHA-256 do UUID da máquina (Windows) ou, como fallback, do MAC
 * address + hostname. É determinístico: reiniciar o app não muda o valor.
 */

const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { createClient } = require('@supabase/supabase-js');
const { getSettings, saveSettings } = require('./settings');
const { getSupabaseClient } = require('./database');

const GRACE_PERIOD_MS = 72 * 60 * 60 * 1000;
const RPC_TIMEOUT_MS = 10_000;
const POWERSHELL_TIMEOUT_MS = 4_000;

/**
 * Projeto Supabase do FORNECEDOR (tabela public.licenses).
 *
 * Preencha antes de gerar o instalador. A anon key é pública por design; a
 * proteção real vem do RLS + da função SECURITY DEFINER. Para testes/builds,
 * LICENSE_SUPABASE_URL e LICENSE_SUPABASE_ANON_KEY têm prioridade.
 *
 * Vazio = usa o Supabase já configurado no app (útil em desenvolvimento).
 */
const DEFAULT_LICENSE_SUPABASE_URL = 'https://mitdvzmunnrpbzpswrsb.supabase.co';
const DEFAULT_LICENSE_SUPABASE_ANON_KEY = 'sb_publishable_5mdaoAsVZ8MOm20DZGJkaQ_p-iSdaDo';

const LICENSE_KEY_PATTERN = /^CHESS-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

const LICENSE_PURCHASE_URL = String(
  process.env.LICENSE_PURCHASE_URL || 'https://discord.com/users/1401221715866157149'
).trim();

let cachedHwid = '';
let cachedClient = null;
let cachedClientUrl = '';
let cachedClientKey = '';
let inFlightCheck = null;
let warnedDevFallback = false;

/* ── Utilidades ────────────────────────────────────────────────────────────── */

function pick(...values) {
  for (const value of values) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (normalized) return normalized;
  }
  return '';
}

function withTimeout(promise, ms, label = 'timeout') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(label);
      error.code = 'timeout';
      reject(error);
    }, ms);
    timer.unref?.();

    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

function normalizeLicenseKey(value) {
  return String(value || '').trim().toUpperCase();
}

function maskLicenseKey(value) {
  const key = normalizeLicenseKey(value);
  if (!key) return '';
  const parts = key.split('-');
  if (parts.length < 2) return '****';
  return `${parts[0]}-****-****-${parts[parts.length - 1]}`;
}

/* ── HWID ──────────────────────────────────────────────────────────────────── */

/**
 * UUID do computador via WMI. Retorna '' quando indisponível (VM sem UUID,
 * PowerShell bloqueado por política etc.), deixando o fallback assumir.
 */
function readWindowsMachineUuid() {
  if (process.platform !== 'win32') return '';

  try {
    const output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-Command',
        '(Get-CimInstance -ClassName Win32_ComputerSystemProduct).UUID',
      ],
      {
        encoding: 'utf8',
        timeout: POWERSHELL_TIMEOUT_MS,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    );

    const uuid = String(output || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) || '';

    if (!uuid || !/[0-9a-f]/i.test(uuid)) return '';

    // Fabricantes que não gravam UUID retornam valores sentinela.
    const lowered = uuid.toLowerCase();
    if (/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(lowered)) return '';
    if (/^f{8}-f{4}-f{4}-f{4}-f{12}$/.test(lowered)) return '';
    if (/^0{32}$/.test(lowered) || /^f{32}$/.test(lowered)) return '';

    return lowered;
  } catch {
    return '';
  }
}

/** MACs físicos (ignora loopback e adaptadores virtuais zerados). */
function collectMacAddresses() {
  const macs = [];

  try {
    for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
      for (const address of addresses || []) {
        if (!address || address.internal) continue;

        const mac = String(address.mac || '').toLowerCase();
        if (!mac || mac === '00:00:00:00:00:00') continue;

        macs.push(`${name}:${mac}`);
      }
    }
  } catch {
    // Sem interfaces legíveis: o hostname ainda diferencia a máquina.
  }

  return macs.sort();
}

function buildHwidSource() {
  const machineUuid = readWindowsMachineUuid();
  if (machineUuid) return `uuid:${machineUuid}`;

  const macs = collectMacAddresses();
  return [
    'fallback',
    macs.join(','),
    os.hostname(),
    os.platform(),
    os.arch(),
  ].join('|');
}

/**
 * HWID estável: SHA-256 em hex minúsculo. O prefixo evita que o mesmo hash
 * seja reutilizado em outro contexto do app.
 */
function getHardwareId() {
  if (cachedHwid) return cachedHwid;

  const source = `chessstream-hub|${buildHwidSource()}`;
  cachedHwid = crypto.createHash('sha256').update(source).digest('hex');
  return cachedHwid;
}

/** Versão curta para exibir no modal/suporte (não serve para validação). */
function getShortHwid(hwid = getHardwareId()) {
  const raw = String(hwid || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
  const chunked = raw.slice(0, 16).match(/.{1,4}/g) || [];
  return chunked.join('-');
}

/* ── Supabase ──────────────────────────────────────────────────────────────── */

function getLicenseClient() {
  const url = pick(process.env.LICENSE_SUPABASE_URL, DEFAULT_LICENSE_SUPABASE_URL);
  const key = pick(process.env.LICENSE_SUPABASE_ANON_KEY, DEFAULT_LICENSE_SUPABASE_ANON_KEY);

  if (url && key) {
    if (cachedClient && cachedClientUrl === url && cachedClientKey === key) {
      return cachedClient;
    }

    try {
      cachedClient = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      cachedClientUrl = url;
      cachedClientKey = key;
      return cachedClient;
    } catch (error) {
      console.error('[Licença] Falha ao criar cliente Supabase:', error?.message || error);
      cachedClient = null;
    }
  }

  // Desenvolvimento: reaproveita o Supabase configurado no app.
  if (!warnedDevFallback) {
    warnedDevFallback = true;
    console.warn(
      '[Licença] LICENSE_SUPABASE_URL/ANON_KEY não configurados — usando o Supabase do app (modo desenvolvimento).'
    );
  }
  return getSupabaseClient();
}

async function callVerifyRpc(client, licenseKey, hwid) {
  const response = await withTimeout(
    client.rpc('verify_and_activate_license', {
      p_license_key: licenseKey,
      p_hwid: hwid,
    }),
    RPC_TIMEOUT_MS,
    'license_rpc_timeout'
  );

  if (response?.error) throw response.error;

  let payload = response?.data;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      payload = null;
    }
  }

  if (!payload || typeof payload !== 'object') {
    throw new Error('Resposta inválida do servidor de licenças.');
  }

  return {
    valid: payload.valid === true,
    reason: String(payload.reason || (payload.valid ? 'active' : 'invalid')),
    message: String(payload.message || ''),
    expiresAt: payload.expires_at || null,
  };
}

function persistLicenseState({ hwid, status, expiresAt, lastValidAt }) {
  const values = {};
  if (hwid !== undefined) values.licenseHwid = hwid;
  if (status !== undefined) values.licenseStatus = status;
  if (expiresAt !== undefined) values.licenseExpiresAt = expiresAt || '';
  if (lastValidAt !== undefined) values.licenseLastValidAt = lastValidAt || '';

  if (Object.keys(values).length) saveSettings(values);
}

/* ── Offline / grace period ───────────────────────────────────────────────── */

function offlineResult({ settings, hwid, clientConfigured }) {
  const expiresAt = settings.licenseExpiresAt || null;
  if (expiresAt) {
    const expiresMs = Date.parse(expiresAt);
    if (Number.isFinite(expiresMs) && expiresMs <= Date.now()) {
      return {
        valid: false,
        reason: 'expired',
        message: 'Esta licença expirou. Renove para continuar usando.',
        expiresAt,
      };
    }
  }

  const lastValidMs = Date.parse(settings.licenseLastValidAt || '');
  const withinGrace = Number.isFinite(lastValidMs)
    && Date.now() >= lastValidMs - 5 * 60 * 1000
    && Date.now() - lastValidMs <= GRACE_PERIOD_MS;
  const sameMachine = !settings.licenseHwid || settings.licenseHwid === hwid;

  if (withinGrace && sameMachine) {
    const remainingMs = GRACE_PERIOD_MS - (Date.now() - lastValidMs);
    const hours = Math.max(1, Math.ceil(remainingMs / (60 * 60 * 1000)));
    return {
      valid: true,
      reason: 'offline_grace',
      message: `Sem conexão — usando a validação offline (${hours}h restantes).`,
      offline: true,
      expiresAt,
      graceRemainingMs: remainingMs,
    };
  }

  return {
    valid: false,
    reason: clientConfigured ? 'network_error' : 'not_configured',
    message: clientConfigured
      ? 'Não foi possível validar a licença. Verifique sua internet.'
      : 'Servidor de licenças não configurado neste aplicativo.',
    expiresAt,
  };
}

/* ── API pública ───────────────────────────────────────────────────────────── */

/**
 * Verifica a licença salva. Consulta o servidor; em falha de rede aceita até
 * 72h desde a última validação bem-sucedida no MESMO HWID.
 */
function checkLicense() {
  if (inFlightCheck) return inFlightCheck;

  inFlightCheck = (async () => {
    const settings = getSettings();
    const licenseKey = normalizeLicenseKey(settings.licenseKey);
    const hwid = getHardwareId();

    if (!licenseKey) {
      return {
        valid: false,
        reason: 'no_key',
        message: 'Nenhuma licença ativada neste computador.',
        hwidShort: getShortHwid(hwid),
      };
    }

    // O store é criptografado por máquina; ainda assim, se o HWID mudou, a
    // licença não vale mais neste computador.
    if (settings.licenseHwid && settings.licenseHwid !== hwid) {
      persistLicenseState({ status: 'hwid_changed', lastValidAt: '' });
      return {
        valid: false,
        reason: 'hwid_changed',
        message: 'A licença foi ativada em outro computador.',
        hwidShort: getShortHwid(hwid),
      };
    }

    const client = getLicenseClient();
    if (!client) {
      return {
        ...offlineResult({ settings, hwid, clientConfigured: false }),
        hwidShort: getShortHwid(hwid),
      };
    }

    try {
      const result = await callVerifyRpc(client, licenseKey, hwid);

      if (result.valid) {
        persistLicenseState({
          hwid,
          status: 'active',
          expiresAt: result.expiresAt,
          lastValidAt: new Date().toISOString(),
        });
        return { ...result, hwidShort: getShortHwid(hwid) };
      }

      // Revogada/expirada/chave de outro PC: invalida o cache offline para
      // que um bloqueio online não seja contornado desligando a internet.
      persistLicenseState({ status: result.reason, lastValidAt: '' });
      return { ...result, hwidShort: getShortHwid(hwid) };
    } catch (error) {
      console.warn('[Licença] Validação online falhou:', error?.message || error);
      return {
        ...offlineResult({ settings, hwid, clientConfigured: true }),
        hwidShort: getShortHwid(hwid),
      };
    }
  })().finally(() => {
    inFlightCheck = null;
  });

  return inFlightCheck;
}

/**
 * Ativa uma chave nova. Só grava localmente depois que o servidor confirma.
 */
async function activateLicense(rawKey) {
  const licenseKey = normalizeLicenseKey(rawKey);
  const hwid = getHardwareId();

  if (!licenseKey) {
    return { valid: false, reason: 'invalid_key', message: 'Cole a chave de licença.' };
  }

  if (!LICENSE_KEY_PATTERN.test(licenseKey)) {
    return {
      valid: false,
      reason: 'invalid_key',
      message: 'Formato inválido. Use CHESS-XXXX-XXXX-XXXX.',
    };
  }

  const client = getLicenseClient();
  if (!client) {
    return {
      valid: false,
      reason: 'not_configured',
      message: 'Servidor de licenças não configurado neste aplicativo.',
    };
  }

  // A chave antiga pode ter sido validada em outro HWID: a nova ativação
  // substitui o estado local só depois da confirmação do servidor.
  try {
    const result = await callVerifyRpc(client, licenseKey, hwid);

    if (!result.valid) {
      return { ...result, hwidShort: getShortHwid(hwid) };
    }

    saveSettings({
      licenseKey,
      licenseHwid: hwid,
      licenseStatus: 'active',
      licenseExpiresAt: result.expiresAt || '',
      licenseLastValidAt: new Date().toISOString(),
    });

    return {
      ...result,
      hwidShort: getShortHwid(hwid),
      keyMasked: maskLicenseKey(licenseKey),
    };
  } catch (error) {
    console.warn('[Licença] Falha ao ativar:', error?.message || error);
    return {
      valid: false,
      reason: 'network_error',
      message: 'Não foi possível conectar ao servidor de licenças. Verifique sua internet.',
      hwidShort: getShortHwid(hwid),
    };
  }
}

/**
 * Estado local (sem rede) para a aba de Configurações. Não substitui
 * checkLicense(): serve apenas como indicador rápido.
 */
function getLocalLicenseStatus() {
  const settings = getSettings();
  const licenseKey = normalizeLicenseKey(settings.licenseKey);
  const hwid = getHardwareId();

  const base = {
    hwidShort: getShortHwid(hwid),
    keyMasked: maskLicenseKey(licenseKey),
    hasKey: Boolean(licenseKey),
    expiresAt: settings.licenseExpiresAt || null,
    lastValidAt: settings.licenseLastValidAt || null,
    activated: Boolean(licenseKey && settings.licenseHwid),
  };

  if (!licenseKey) {
    return { ...base, valid: false, reason: 'no_key', message: 'Nenhuma licença ativada.' };
  }

  if (settings.licenseHwid && settings.licenseHwid !== hwid) {
    return { ...base, valid: false, reason: 'hwid_changed', message: 'Licença vinculada a outro computador.' };
  }

  if (['revoked', 'expired'].includes(settings.licenseStatus)) {
    return {
      ...base,
      valid: false,
      reason: settings.licenseStatus,
      message: settings.licenseStatus === 'revoked' ? 'Licença revogada.' : 'Licença expirada.',
    };
  }

  if (settings.licenseExpiresAt) {
    const expiresMs = Date.parse(settings.licenseExpiresAt);
    if (Number.isFinite(expiresMs) && expiresMs <= Date.now()) {
      return { ...base, valid: false, reason: 'expired', message: 'Licença expirada.' };
    }
  }

  const lastValidMs = Date.parse(settings.licenseLastValidAt || '');
  if (Number.isFinite(lastValidMs) && Date.now() - lastValidMs <= GRACE_PERIOD_MS) {
    return { ...base, valid: true, reason: 'cached', message: 'Licença válida (validação recente).' };
  }

  return { ...base, valid: false, reason: 'needs_check', message: 'Licença aguardando validação online.' };
}

module.exports = {
  GRACE_PERIOD_MS,
  LICENSE_PURCHASE_URL,
  LICENSE_KEY_PATTERN,
  normalizeLicenseKey,
  maskLicenseKey,
  getHardwareId,
  getShortHwid,
  checkLicense,
  activateLicense,
  getLocalLicenseStatus,
};
