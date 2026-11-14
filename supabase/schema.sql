-- ─────────────────────────────────────────────────────────────
-- ChessStream Hub — Schema Supabase
-- Execute no SQL Editor do seu projeto em supabase.com
--
-- Arquivo 100% idempotente: pode ser reexecutado quantas vezes for
-- necessário. Policies usam DROP ... IF EXISTS antes do CREATE (o
-- PostgreSQL não possui CREATE POLICY IF NOT EXISTS) e a ordem é:
--   1. tabelas  2. colunas  3. segurança/RLS  4. Realtime  5. índices
-- ─────────────────────────────────────────────────────────────

-- ═══════════════════════════════════════════════════════════════
-- 1. TABELAS
-- ═══════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- Pagamentos VIP (fluxo legado Mercado Pago, recebido pelo webhook Vercel)
CREATE TABLE IF NOT EXISTS public.fila_vip (
  id           BIGSERIAL PRIMARY KEY,
  payment_id   TEXT NOT NULL UNIQUE,
  username     TEXT NOT NULL,
  chess_nick   TEXT,
  platform     TEXT DEFAULT 'unknown',
  amount_cents INTEGER NOT NULL DEFAULT 0,
  processed    BOOLEAN DEFAULT FALSE,
  paid_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Perfis dos jogadores
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT UNIQUE,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fila de jogadores
CREATE TABLE IF NOT EXISTS public.queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_name TEXT NOT NULL,
  chess_username TEXT,
  platform TEXT DEFAULT 'chess.com',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'playing', 'completed', 'cancelled')),
  position INT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Credenciais do LivePix de cada streamer. A service_role (webhook) lê esta
-- tabela; a anon key (app) só escreve via register_streamer_config().
CREATE TABLE IF NOT EXISTS public.streamer_configs (
  streamer_id           TEXT PRIMARY KEY,
  livepix_client_id     TEXT NOT NULL,
  livepix_client_secret TEXT NOT NULL,
  webhook_secret        TEXT NOT NULL,
  owner_secret_hash     TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Licenças comerciais (assinatura mensal, sem vínculo por máquina).
-- O app NÃO acessa esta tabela: a ativação/validação passa pela função
-- Vercel /api/license, que usa a service_role. Assim a anon key nunca
-- consegue listar, inserir ou alterar chaves.
CREATE TABLE IF NOT EXISTS public.licenses (
  license_key    TEXT PRIMARY KEY,             -- CSH-XXXX-XXXX-XXXX
  email          TEXT,                         -- e-mail do comprador
  status         TEXT NOT NULL DEFAULT 'active' -- active | expired | revoked
    CHECK (status IN ('active', 'expired', 'revoked')),
  activated_at   TIMESTAMPTZ,                  -- primeiro uso
  expires_at     TIMESTAMPTZ,                  -- activated_at + 30 dias
  last_check_at  TIMESTAMPTZ,                  -- última validação online
  notes          TEXT,                         -- observações do dono
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Histórico de partidas
CREATE TABLE IF NOT EXISTS public.match_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_id UUID REFERENCES public.queue(id) ON DELETE SET NULL,
  player_name TEXT NOT NULL,
  opponent_name TEXT,
  result TEXT
    CHECK (result IN ('win', 'loss', 'draw', 'ongoing')),
  game_url TEXT,
  played_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ═══════════════════════════════════════════════════════════════
-- 2. COLUNAS (migrações de instalações antigas)
-- ═══════════════════════════════════════════════════════════════

-- Entradas VIP do LivePix anexam o valor doado e o id de origem (idempotência:
-- o LivePix reenvia o mesmo webhook por até 24h se não receber HTTP 200).
ALTER TABLE public.fila_vip ADD COLUMN IF NOT EXISTS amount_cents INTEGER NOT NULL DEFAULT 0;

-- Identidade do streamer dono do pagamento (webhook Mercado Pago/LivePix).
-- Linhas antigas permanecem NULL e seguem o fluxo legado.
ALTER TABLE public.fila_vip ADD COLUMN IF NOT EXISTS streamer_id TEXT;

ALTER TABLE public.queue ADD COLUMN IF NOT EXISTS amount_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.queue ADD COLUMN IF NOT EXISTS source_id TEXT;
ALTER TABLE public.streamer_configs ADD COLUMN IF NOT EXISTS owner_secret_hash TEXT;

-- Cada instalação do app possui um streamer_id próprio. O webhook grava a
-- linha com esse id e o app escuta apenas os eventos da sua própria fila.
ALTER TABLE public.queue ADD COLUMN IF NOT EXISTS streamer_id TEXT;

-- Histórico também é multi-tenant: a leitura só acontece pela RPC
-- get_streamer_history(), que filtra por este campo.
ALTER TABLE public.match_history ADD COLUMN IF NOT EXISTS streamer_id TEXT;

-- ── Licenças: migração do modelo antigo (HWID) para assinatura mensal ──
ALTER TABLE public.licenses ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE public.licenses ADD COLUMN IF NOT EXISTS last_check_at TIMESTAMPTZ;
ALTER TABLE public.licenses ADD COLUMN IF NOT EXISTS notes TEXT;

-- Instalações antigas guardavam o e-mail em customer_email.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'licenses'
      AND column_name  = 'customer_email'
  ) THEN
    EXECUTE 'UPDATE public.licenses
                SET email = COALESCE(email, customer_email)
              WHERE email IS NULL';
  END IF;
END
$$;

-- Chaves antigas ativadas sem prazo passam a valer 30 dias a partir da
-- ativação, preservando quem já tinha licença antes da migração.
UPDATE public.licenses
   SET expires_at = activated_at + INTERVAL '30 days'
 WHERE expires_at IS NULL
   AND activated_at IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════
-- 3. SEGURANÇA: RLS, GRANTS, FUNÇÕES E POLICIES
-- ═══════════════════════════════════════════════════════════════

-- RLS habilitado em todas as tabelas expostas via API.
ALTER TABLE public.fila_vip         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.queue            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.match_history    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.streamer_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.licenses         ENABLE ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA public TO anon, authenticated;

-- Superfície mínima: parte de um estado limpo para não herdar GRANTs padrão
-- do Supabase (que incluem DELETE) em instalações novas ou reexecuções.
REVOKE ALL ON public.fila_vip         FROM anon, authenticated;
REVOKE ALL ON public.profiles         FROM anon, authenticated;
REVOKE ALL ON public.queue            FROM anon, authenticated;
REVOKE ALL ON public.match_history    FROM anon, authenticated;
REVOKE ALL ON public.streamer_configs FROM anon, authenticated;
REVOKE ALL ON public.licenses         FROM anon, authenticated;

-- O app desktop (anon) lê os pagamentos legados do Mercado Pago.
GRANT SELECT ON public.fila_vip TO anon;

-- O app desktop lê e mantém a fila/histórico, mas nunca DELETE.
GRANT SELECT, INSERT, UPDATE
  ON public.profiles, public.queue, public.match_history
  TO anon, authenticated;

-- A service_role (webhook) lê as credenciais. anon/authenticated NÃO têm
-- acesso direto: a escrita ocorre só pela função SECURITY DEFINER abaixo.
GRANT SELECT ON public.streamer_configs TO service_role;

-- Suporte/backoffice e a função Vercel /api/license usam a service_role.
-- anon/authenticated continuam sem qualquer acesso direto à tabela: expor
-- SELECT permitiria listar todas as chaves e revendê-las.
GRANT SELECT, INSERT, UPDATE ON public.licenses TO service_role;

-- Reforço explícito: nenhuma tabela concede DELETE a anon/authenticated.
REVOKE DELETE
  ON public.fila_vip, public.profiles, public.queue, public.match_history
  FROM anon, authenticated;

-- Grava/atualiza as credenciais do streamer sem expor a tabela.
DROP FUNCTION IF EXISTS public.register_streamer_config(TEXT, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.register_streamer_config(
  p_streamer_id           TEXT,
  p_client_id             TEXT,
  p_client_secret         TEXT,
  p_streamer_secret       TEXT
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_hash TEXT;
BEGIN
  IF p_streamer_id IS NULL OR p_streamer_id !~ '^[A-Za-z0-9_-]{16,64}$' THEN
    RAISE EXCEPTION 'streamer_id inválido';
  END IF;

  IF coalesce(trim(p_client_id), '') = ''
     OR coalesce(trim(p_client_secret), '') = '' THEN
    RAISE EXCEPTION 'credenciais LivePix incompletas';
  END IF;

  IF p_streamer_secret IS NULL OR pg_catalog.length(pg_catalog.btrim(p_streamer_secret)) < 32 THEN
    RAISE EXCEPTION 'streamer_secret inválido';
  END IF;

  v_hash := encode(extensions.digest(convert_to(pg_catalog.btrim(p_streamer_secret), 'UTF8'), 'sha256'), 'hex');

  INSERT INTO public.streamer_configs (
    streamer_id,
    livepix_client_id,
    livepix_client_secret,
    webhook_secret,
    owner_secret_hash,
    updated_at
  ) VALUES (
    p_streamer_id,
    trim(p_client_id),
    trim(p_client_secret),
    '',
    v_hash,
    pg_catalog.now()
  )
  ON CONFLICT (streamer_id) DO UPDATE
    SET livepix_client_id     = excluded.livepix_client_id,
        livepix_client_secret = excluded.livepix_client_secret,
        updated_at            = pg_catalog.now()
    WHERE public.streamer_configs.owner_secret_hash IS NULL
       OR public.streamer_configs.owner_secret_hash = v_hash;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unauthorized: streamer_id pertence a outra instalação.';
  END IF;
END;
$$;

-- Executa apenas a função; nunca a tabela.
REVOKE ALL ON FUNCTION public.register_streamer_config(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_streamer_config(TEXT, TEXT, TEXT, TEXT)
  TO anon, authenticated;

-- ── Leitura multi-tenant da fila/histórico ──────────────────────────────
-- Todas as instalações compartilham a mesma anon key, então o RLS não
-- consegue identificar o tenant pelo JWT. O SELECT direto em public.queue e
-- public.match_history fica bloqueado (sem policy de SELECT) e a leitura
-- acontece somente por estas funções SECURITY DEFINER, que exigem um
-- streamer_id válido e devolvem apenas as linhas daquele streamer.

DROP FUNCTION IF EXISTS public.get_streamer_queue(TEXT);

CREATE OR REPLACE FUNCTION public.get_streamer_queue(p_streamer_id TEXT)
RETURNS SETOF public.queue
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_streamer_id TEXT := pg_catalog.btrim(coalesce(p_streamer_id, ''));
BEGIN
  IF v_streamer_id = '' OR pg_catalog.length(v_streamer_id) < 16 THEN
    RAISE EXCEPTION 'streamer_id inválido';
  END IF;

  RETURN QUERY
  SELECT q.*
    FROM public.queue AS q
   WHERE q.streamer_id = v_streamer_id
     AND q.status IN ('pending', 'playing')
   ORDER BY q.position ASC NULLS LAST, q.created_at ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.get_streamer_queue(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_streamer_queue(TEXT) TO anon, authenticated;

DROP FUNCTION IF EXISTS public.get_streamer_history(TEXT, INT);

CREATE OR REPLACE FUNCTION public.get_streamer_history(
  p_streamer_id TEXT,
  p_limit INT DEFAULT 50
) RETURNS SETOF public.match_history
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_streamer_id TEXT := pg_catalog.btrim(coalesce(p_streamer_id, ''));
  v_limit       INT  := GREATEST(1, LEAST(coalesce(p_limit, 50), 200));
BEGIN
  IF v_streamer_id = '' OR pg_catalog.length(v_streamer_id) < 16 THEN
    RAISE EXCEPTION 'streamer_id inválido';
  END IF;

  RETURN QUERY
  SELECT h.*
    FROM public.match_history AS h
   WHERE h.streamer_id = v_streamer_id
   ORDER BY h.played_at DESC
   LIMIT v_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.get_streamer_history(TEXT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_streamer_history(TEXT, INT)
  TO anon, authenticated;

-- ── Licenças: ativação/validação exclusivamente via Vercel ──────────────
-- A função antiga vinculava a chave ao HWID e foi removida: além de não ser
-- mais usada pelo app, ela permitia ativar chaves sem definir o prazo de 30
-- dias. A ativação agora é feita por vercel-webhook/api/license.js com a
-- service_role, que nunca é exposta ao cliente.
DROP FUNCTION IF EXISTS public.verify_and_activate_license(TEXT, TEXT);

-- Atualiza updated_at automaticamente
CREATE OR REPLACE FUNCTION public.set_queue_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END;
$$;

-- ─── Policies ──────────────────────────────────────────────────
-- DROP IF EXISTS antes de cada CREATE: reexecutar o script não gera 42710.

DROP POLICY IF EXISTS "service_role pode inserir" ON public.fila_vip;
DROP POLICY IF EXISTS "anon pode ler"             ON public.fila_vip;

DROP POLICY IF EXISTS profiles_select_public ON public.profiles;
DROP POLICY IF EXISTS profiles_insert_public ON public.profiles;
DROP POLICY IF EXISTS profiles_update_public ON public.profiles;
DROP POLICY IF EXISTS profiles_delete_public ON public.profiles;

DROP POLICY IF EXISTS queue_select_public ON public.queue;
DROP POLICY IF EXISTS queue_insert_public ON public.queue;
DROP POLICY IF EXISTS queue_update_public ON public.queue;
DROP POLICY IF EXISTS queue_delete_public ON public.queue;

DROP POLICY IF EXISTS match_history_select_public ON public.match_history;
DROP POLICY IF EXISTS match_history_insert_public ON public.match_history;
DROP POLICY IF EXISTS match_history_update_public ON public.match_history;
DROP POLICY IF EXISTS match_history_delete_public ON public.match_history;

-- fila_vip: service_role insere; anon apenas lê.
CREATE POLICY "service_role pode inserir"
  ON public.fila_vip FOR INSERT
  TO service_role
  WITH CHECK (true);

CREATE POLICY "anon pode ler"
  ON public.fila_vip FOR SELECT
  TO anon
  USING (true);

-- profiles: SELECT, INSERT, UPDATE (sem DELETE).
CREATE POLICY profiles_select_public
  ON public.profiles FOR SELECT TO anon, authenticated
  USING (true);

CREATE POLICY profiles_insert_public
  ON public.profiles FOR INSERT TO anon, authenticated
  WITH CHECK (true);

CREATE POLICY profiles_update_public
  ON public.profiles FOR UPDATE TO anon, authenticated
  USING (true)
  WITH CHECK (true);

-- queue: INSERT e UPDATE (sem DELETE e sem SELECT direto).
-- O SELECT é feito exclusivamente por get_streamer_queue(). Como a anon key é
-- compartilhada, o RLS não distingue tenants pelo JWT; por isso toda linha
-- gravada precisa carregar um streamer_id plausível.
CREATE POLICY queue_insert_public
  ON public.queue FOR INSERT TO anon, authenticated
  WITH CHECK (
    streamer_id IS NOT NULL
    AND pg_catalog.length(pg_catalog.btrim(streamer_id)) >= 16
  );

CREATE POLICY queue_update_public
  ON public.queue FOR UPDATE TO anon, authenticated
  USING (
    streamer_id IS NOT NULL
    AND pg_catalog.length(pg_catalog.btrim(streamer_id)) >= 16
  )
  WITH CHECK (
    streamer_id IS NOT NULL
    AND pg_catalog.length(pg_catalog.btrim(streamer_id)) >= 16
  );

-- match_history: INSERT e UPDATE (sem DELETE e sem SELECT direto).
-- O histórico é lido por get_streamer_history().
CREATE POLICY match_history_insert_public
  ON public.match_history FOR INSERT TO anon, authenticated
  WITH CHECK (
    streamer_id IS NOT NULL
    AND pg_catalog.length(pg_catalog.btrim(streamer_id)) >= 16
  );

CREATE POLICY match_history_update_public
  ON public.match_history FOR UPDATE TO anon, authenticated
  USING (
    streamer_id IS NOT NULL
    AND pg_catalog.length(pg_catalog.btrim(streamer_id)) >= 16
  )
  WITH CHECK (
    streamer_id IS NOT NULL
    AND pg_catalog.length(pg_catalog.btrim(streamer_id)) >= 16
  );

-- ─── Trigger ───────────────────────────────────────────────────

DROP TRIGGER IF EXISTS set_queue_updated_at_trigger ON public.queue;

CREATE TRIGGER set_queue_updated_at_trigger
BEFORE UPDATE ON public.queue
FOR EACH ROW
EXECUTE FUNCTION public.set_queue_updated_at();

-- ═══════════════════════════════════════════════════════════════
-- 4. REALTIME (todas as tabelas já existem neste ponto)
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.fila_vip REPLICA IDENTITY FULL;
ALTER TABLE public.queue    REPLICA IDENTITY FULL;

-- ADD TABLE não é idempotente; o bloco garante a publicação e verifica cada
-- tabela antes de adicioná-la.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'
  ) THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'fila_vip'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.fila_vip;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'queue'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.queue;
  END IF;
END
$$;

-- ═══════════════════════════════════════════════════════════════
-- 5. ÍNDICES (por último, com todas as colunas já criadas)
-- ═══════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_fila_vip_username  ON public.fila_vip(username);
CREATE INDEX IF NOT EXISTS idx_fila_vip_processed ON public.fila_vip(processed);
CREATE INDEX IF NOT EXISTS idx_fila_vip_paid_at   ON public.fila_vip(paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_fila_vip_streamer  ON public.fila_vip(streamer_id);

-- UNIQUE necessário para a idempotência do webhook (ON CONFLICT / erro 23505).
CREATE UNIQUE INDEX IF NOT EXISTS queue_source_id_key
  ON public.queue (source_id);

CREATE INDEX IF NOT EXISTS queue_streamer_status_idx
  ON public.queue (streamer_id, status);

CREATE INDEX IF NOT EXISTS queue_streamer_position_idx
  ON public.queue (streamer_id, position);

CREATE INDEX IF NOT EXISTS queue_status_idx
  ON public.queue (status);

CREATE INDEX IF NOT EXISTS queue_created_at_idx
  ON public.queue (created_at);

-- Histórico consultado por get_streamer_history() (tenant + ordem).
CREATE INDEX IF NOT EXISTS match_history_streamer_played_idx
  ON public.match_history (streamer_id, played_at DESC);

-- ─── Sistema de Licenças (assinatura) ───────────────────────────────
-- A PK já indexa license_key; o status é o filtro usado pelo painel/endpoint.
CREATE INDEX IF NOT EXISTS idx_licenses_status ON public.licenses (status);

-- O modelo de assinatura não vincula licença a máquina: remove o índice de
-- HWID herdado de instalações antigas.
DROP INDEX IF EXISTS public.licenses_hwid_idx;
