-- ─────────────────────────────────────────────────────────────
-- ChessStream Hub — Schema Supabase
-- Execute no SQL Editor do seu projeto em supabase.com
-- ─────────────────────────────────────────────────────────────

-- Tabela de pagamentos VIP (recebida pelo webhook Vercel)
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

-- Habilita Row Level Security
ALTER TABLE public.fila_vip ENABLE ROW LEVEL SECURITY;

-- Permite que a service_role key (usada pelo webhook) insira
CREATE POLICY "service_role pode inserir"
  ON public.fila_vip FOR INSERT
  TO service_role
  WITH CHECK (true);

-- Permite que a anon key (usada pelo app desktop) leia
CREATE POLICY "anon pode ler"
  ON public.fila_vip FOR SELECT
  TO anon
  USING (true);

-- ─── Realtime ──────────────────────────────────────────────────
-- Habilita Realtime para as tabelas usadas via WebSocket.
-- O bloco DO evita erro ao reaplicar o script (ADD TABLE não é idempotente).
ALTER TABLE public.fila_vip REPLICA IDENTITY FULL;
ALTER TABLE public.queue    REPLICA IDENTITY FULL;

DO $$
BEGIN
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

-- ─── Índices ────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_fila_vip_username  ON public.fila_vip(username);
CREATE INDEX IF NOT EXISTS idx_fila_vip_processed ON public.fila_vip(processed);
CREATE INDEX IF NOT EXISTS idx_fila_vip_paid_at   ON public.fila_vip(paid_at DESC);

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

-- Entradas VIP do LivePix anexam o valor doado e o id de origem (idempotência:
-- o LivePix reenvia o mesmo webhook por até 24h se não receber HTTP 200).
ALTER TABLE public.queue ADD COLUMN IF NOT EXISTS amount_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.queue ADD COLUMN IF NOT EXISTS source_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS queue_source_id_key
  ON public.queue (source_id);

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

-- Índices para consultas da fila
CREATE INDEX IF NOT EXISTS queue_status_idx
  ON public.queue (status);

CREATE INDEX IF NOT EXISTS queue_created_at_idx
  ON public.queue (created_at);

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

DROP TRIGGER IF EXISTS set_queue_updated_at_trigger ON public.queue;

CREATE TRIGGER set_queue_updated_at_trigger
BEFORE UPDATE ON public.queue
FOR EACH ROW
EXECUTE FUNCTION public.set_queue_updated_at();

-- Ativa RLS
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.match_history ENABLE ROW LEVEL SECURITY;

-- Permissões necessárias para acesso via API
GRANT USAGE ON SCHEMA public TO anon, authenticated;

-- DELETE é feito exclusivamente pelo webhook (service_role),
-- nunca pela anon key do app desktop.
GRANT SELECT, INSERT, UPDATE
  ON public.profiles, public.queue, public.match_history
  TO anon, authenticated;

-- Remove policies anteriores com estes nomes para permitir reaplicar o script
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

-- profiles: SELECT, INSERT, UPDATE
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

-- queue: SELECT, INSERT, UPDATE
CREATE POLICY queue_select_public
  ON public.queue FOR SELECT TO anon, authenticated
  USING (true);

CREATE POLICY queue_insert_public
  ON public.queue FOR INSERT TO anon, authenticated
  WITH CHECK (true);

CREATE POLICY queue_update_public
  ON public.queue FOR UPDATE TO anon, authenticated
  USING (true)
  WITH CHECK (true);

-- match_history: SELECT, INSERT, UPDATE
CREATE POLICY match_history_select_public
  ON public.match_history FOR SELECT TO anon, authenticated
  USING (true);

CREATE POLICY match_history_insert_public
  ON public.match_history FOR INSERT TO anon, authenticated
  WITH CHECK (true);

CREATE POLICY match_history_update_public
  ON public.match_history FOR UPDATE TO anon, authenticated
  USING (true)
  WITH CHECK (true);

