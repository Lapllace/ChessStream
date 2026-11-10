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
-- Habilita Realtime para esta tabela (necessário para o WebSocket funcionar)
ALTER PUBLICATION supabase_realtime ADD TABLE public.fila_vip;

-- ─── Índices ────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_fila_vip_username  ON public.fila_vip(username);
CREATE INDEX IF NOT EXISTS idx_fila_vip_processed ON public.fila_vip(processed);
CREATE INDEX IF NOT EXISTS idx_fila_vip_paid_at   ON public.fila_vip(paid_at DESC);
