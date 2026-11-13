# ChessStream Hub — Guia de Setup

## Pré-requisitos

- Node.js 18+
- Conta no [Supabase](https://supabase.com) (gratuito) — Opção B
- Conta na [Vercel](https://vercel.com) (gratuito) — Opção B
- Conta de desenvolvedor no [Mercado Pago](https://www.mercadopago.com.br/developers) — Opção B

---

## 1. Instalar dependências

```bash
cd chessstream-hub
npm install
```

---

## 2. Configurar variáveis de ambiente

```bash
cp .env.example .env
```

Abra o `.env` e preencha:

| Variável | Onde pegar |
|---|---|
| `CHESS_STREAMER_NICK` | Seu nick no Chess.com |
| `TWITCH_OAUTH_TOKEN` | [twitchapps.com/tmi](https://twitchapps.com/tmi/) |
| `TWITCH_CHANNEL` | Nome do seu canal (sem #) |
| `YOUTUBE_CHANNEL_ID` | URL do seu canal → `about` → copiar ID |
| `GOOGLE_CLIENT_ID` | Credencial OAuth de aplicativo desktop no Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | Credencial OAuth de aplicativo desktop no Google Cloud Console |

As mesmas configurações podem ser informadas pelo botão **Configurações** no painel.
Os valores salvos pela interface ficam persistidos localmente e substituem os valores do
`.env` nas execuções seguintes. O `.env` continua sendo usado como fallback para
desenvolvimento.

Para conectar o YouTube, abra **Configurações → Entrar com o Google**. O canal
é detectado automaticamente e os tokens OAuth são persistidos localmente.

---

## 3. Rodar o app (Opção A — só fila pelo chat)

```bash
npm start
```

O painel abre. Teste digitando `!jogar seu_nick` em um chat de teste.

---

## 4. Setup do Supabase (Opção B)

1. Crie um projeto em [supabase.com](https://supabase.com)
2. Vá em **SQL Editor** e cole o conteúdo de `supabase/schema.sql`
3. Clique em **Run**
4. Vá em **Settings → API** e copie:
   - `Project URL` → `SUPABASE_URL` no `.env`
   - `anon public` key → `SUPABASE_ANON_KEY` no `.env`
   - `service_role` key → guarde para a Vercel (próximo passo)

---

## 5. Deploy do Webhook na Vercel (Opção B)

```bash
npm install -g vercel
cd vercel-webhook
vercel deploy
```

Na Vercel, adicione as variáveis de ambiente:

| Variável | Valor |
|---|---|
| `SUPABASE_URL` | URL do seu projeto Supabase |
| `SUPABASE_SERVICE_KEY` | service_role key do Supabase |
| `MP_ACCESS_TOKEN` | Token do Mercado Pago (produção ou sandbox) |
| `MP_MIN_VALUE_CENTS` | Valor mínimo em centavos (ex: `500` = R$5) |
| `LIVEPIX_CLIENT_ID` | client_id da aplicação criada no painel de desenvolvedores LivePix |
| `LIVEPIX_CLIENT_SECRET` | client_secret da aplicação LivePix |
| `LIVEPIX_OAUTH_SCOPE` | `messages:read` (padrão) |
| `LIVEPIX_WEBHOOK_SECRET` | Segredo compartilhado para validar a chamada do webhook |

> ⚠️ Rode novamente `supabase/schema.sql` depois de atualizar o app: ele adiciona
> `amount_cents`/`source_id` em `public.queue` e habilita Realtime na tabela.

Após o deploy, você terá URLs como:
```
https://chessstream-webhook.vercel.app/api/webhook       (Mercado Pago)
https://chessstream-webhook.vercel.app/api/livepix       (LivePix)
```

---

## 6. Configurar Webhook no Mercado Pago (Opção B)

1. Acesse [mercadopago.com.br/developers](https://www.mercadopago.com.br/developers)
2. Vá em **Suas integrações → Webhooks**
3. Adicione a URL da Vercel acima
4. Marque apenas o evento **`payment`**

### Passando dados do viewer no pagamento

Quando gerar um QR Code / link de pagamento, passe o `external_reference` com o formato:
```
twitch:NomeDoViewer:nick_chess_do_viewer
```

Exemplo via API MP:
```js
{
  external_reference: "twitch:Joaozinho:joao_chess",
  transaction_amount: 10.00,
  ...
}
```

---

## 6.1. Configurar Webhook no LivePix (entrada VIP via PIX)

1. Crie uma aplicação no painel de desenvolvedores da LivePix e copie
   `client_id`/`client_secret` para as variáveis da Vercel.
2. Configure o webhook da LivePix com a URL:

```
https://seu-projeto.vercel.app/api/livepix?secret=SEU_LIVEPIX_WEBHOOK_SECRET
```

3. O espectador doa pelo LivePix com a mensagem `!jogar <nick_chess>`
   (ex.: `Manda bala, !jogar Hikaru`).
4. O endpoint busca os detalhes da mensagem na API do LivePix, extrai
   valor/doador/mensagem e insere em `public.queue` com `status = 'pending'`
   e `priority = 'vip'`. O app recebe via Supabase Realtime e atualiza a fila.

> O webhook da LivePix envia apenas o `id` do recurso; por isso o endpoint
> autentica via OAuth2 (`client_credentials`) e consulta `GET /v2/messages/{id}`.
> Sem `LIVEPIX_CLIENT_ID`/`LIVEPIX_CLIENT_SECRET` o fluxo não funciona.

---

## 7. Testar o fluxo completo (Opção B)

1. Rode o app: `npm start`
2. No Supabase → SQL Editor, insira uma linha manualmente para simular pagamento:

```sql
INSERT INTO fila_vip (payment_id, username, chess_nick, platform, amount_cents)
VALUES ('test-001', 'Joaozinho', 'joao_chess123', 'twitch', 1000);
```

3. O painel deve tocar o som e mostrar o toast VIP em ~1 segundo.

---

## Comandos do chat

| Comando | Quem usa | Efeito |
|---|---|---|
| `!jogar <nick>` | Viewer | Entra na fila |
| `!posicao` | Viewer | Vê sua posição |
| `!sair` | Viewer | Sai da fila |
| `!proximo` | Streamer/Mod | Puxa próximo da fila e abre Chess.com |
| `!pular` | Streamer/Mod | Move atual para o fim, puxa próximo |
| `!fila pausar` | Streamer/Mod | Para novas entradas |
| `!fila retomar` | Streamer/Mod | Reabre a fila |

---

## Sistema de prioridades

| Cor da barra | Nível | Quem |
|---|---|---|
| Verde | Ultra VIP (1) | Convidado direto do streamer |
| Dourado | VIP Pago (2) | Doação via Pix / assinante |
| Azul | Membro (3) | Sub Twitch / membro YouTube |
| Sem barra | Padrão (4) | Viewer comum |
