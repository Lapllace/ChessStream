# 🔐 Security — ChessStream Hub

Este documento descreve os pontos de segurança que devem ser verificados antes de usar o aplicativo com dados ou pagamentos reais.

## Segredos e credenciais

Nunca faça commit de:

- `.env` ou arquivos com tokens.
- Cookies TikTok (`sessionid`).
- Tokens Twitch.
- Arquivos JSON de credenciais OAuth do Google.
- Credenciais `service_role` do Supabase.
- Token de acesso do Mercado Pago.

Use `.env.example` somente como modelo, sem valores reais. Arquivos locais de credenciais devem permanecer ignorados pelo Git. Antes de publicar o aplicativo, verifique cuidadosamente os arquivos incluídos pelo `electron-builder`.

## Supabase e Row Level Security

O schema versionado habilita RLS em tabelas principais. `public.queue` e `public.match_history` não têm policy de `SELECT` para `anon`: a leitura passa pelas RPCs `get_streamer_queue()`/`get_streamer_history()`, que filtram por `streamer_id`. Ainda assim, `profiles` e `fila_vip` mantêm leitura pública e o `INSERT`/`UPDATE` da fila exige apenas um `streamer_id` com 16+ caracteres. RLS habilitado, por si só, não significa que os dados estejam restritos.

**Antes de produção:**

1. Revise cada `GRANT` e `CREATE POLICY` em `supabase/schema.sql`.
2. Remova acesso anônimo de escrita quando não for indispensável.
3. Limite leitura e alteração por usuário/identidade confiável.
4. Nunca distribua a chave `service_role` no aplicativo desktop.
5. Teste as policies com usuários anônimos e autenticados em um ambiente separado.

## Webhook Mercado Pago

A função em `vercel-webhook/api/webhook.js` consulta o pagamento na API do Mercado Pago e aceita apenas status `approved` e valores acima do mínimo.

A validação é fail-closed:

- Sem `MERCADO_PAGO_WEBHOOK_SECRET`, o endpoint responde `500` e não processa o pagamento.
- Sem os headers `x-signature`/`x-request-id` ou com HMAC inválido (`crypto.timingSafeEqual`), responde `401`.
- O parâmetro opcional `?streamer=<streamer_id>` grava o tenant em `fila_vip.streamer_id`; URLs antigas sem ele continuam aceitas.

Antes de produção:

- Valide o formato e os limites de `external_reference`.
- Mantenha `MP_ACCESS_TOKEN`, `MERCADO_PAGO_WEBHOOK_SECRET` e `SUPABASE_SERVICE_KEY` somente como variáveis secretas do ambiente Vercel.
- Mantenha idempotência por `payment_id` (a tabela usa restrição UNIQUE).
- Não registre tokens ou dados sensíveis nos logs.

## OAuth e sessões

- Use credenciais OAuth do tipo apropriado para aplicativo desktop.
- Solicite somente os escopos necessários.
- Não compartilhe arquivos de token ou cookies.
- Ao revogar uma sessão, remova também os dados locais persistidos pelo aplicativo.
- Confirme que a janela OAuth e o redirect local aceitam somente o fluxo esperado.

## Checklist de release

- [ ] Revisar políticas RLS e grants.
- [ ] Confirmar `MERCADO_PAGO_WEBHOOK_SECRET` na Vercel (validação fail-closed).
- [ ] Confirmar ausência de segredos no Git e nos artefatos.
- [ ] Revisar a lista `build.files` do electron-builder.
- [ ] Testar logout, expiração de token e reconexão.
- [ ] Atualizar dependências e analisar alertas de segurança.
